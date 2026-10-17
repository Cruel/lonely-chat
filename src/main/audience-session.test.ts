import { describe, expect, it } from 'vitest';
import { AudienceService } from './audience-service';
import { ChatService } from './chat-service';
import { SessionController } from './session-controller';
import { FakeInference, type InferenceInput, type InferenceProvider } from './fake-inference';
import { FakeClock, flushMicrotasks as flush } from './test-support/fake-clock';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';
import { AUTHOR_PLACEHOLDER } from '../shared/audience-contract';

describe('audience continuity over inference cycles', () => {
  it('generates a roster before requesting chat; supplies resolved authors and history next cycle', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    const audience = new AudienceService(null, 3);
    await audience.open();
    const inputs: InferenceInput[] = [];
    let generated = 0;
    const fixture = new FakeInference();
    const provider: InferenceProvider = {
      generateRoster: async (count, excluded, signal) => {
        generated++;
        return fixture.generateRoster(count, excluded, signal);
      },
      generate: async (input) => {
        inputs.push(input);
        return {
          events: [],
          messages: [
            {
              author: AUTHOR_PLACEHOLDER,
              text: `cycle ${input.cycle}`,
              color: '#ffffff',
              offsetMs: 0,
            },
          ],
        };
      },
    };
    const session = new SessionController(
      chat,
      provider,
      clock,
      { ...DEFAULT_PREFERENCES, cycleIntervalMs: 1500 },
      undefined,
      audience,
    );
    session.start('live game', 'fake');
    await flush();
    expect(generated).toBe(1);
    expect(inputs[0].roster?.map((item) => item.author)).toEqual([
      'pixelpilot',
      'lunar_fox',
      'nightowl',
    ]);
    expect(chat.snapshot().messages.map((item) => item.author)).toEqual(['pixelpilot']);
    clock.advance(1500);
    await flush();
    expect(inputs[1].recentChat).toMatchObject([{ author: 'pixelpilot', text: 'cycle 1' }]);
    expect(inputs[1].roster).toEqual(inputs[0].roster);
    expect(chat.snapshot().messages.map((item) => item.author)).toEqual([
      'pixelpilot',
      'lunar_fox',
    ]);
    expect(generated).toBe(1);
    session.stop();
    expect(chat.snapshot().messages.map((item) => item.author)).toEqual([
      'pixelpilot',
      'lunar_fox',
    ]);
  });

  it('rejects unlisted author atomically while preserving prior presented chat and event state', async () => {
    const clock = new FakeClock();
    const chat = new ChatService();
    const audience = new AudienceService(null, 3);
    await audience.open();
    const fixture = new FakeInference();
    let count = 0;
    const provider: InferenceProvider = {
      generateRoster: (size, excluded, signal) => fixture.generateRoster(size, excluded, signal),
      generate: async () => {
        count++;
        if (count === 1)
          return {
            events: [],
            messages: [
              {
                author: AUTHOR_PLACEHOLDER,
                text: 'first',
                color: '#ffffff',
                offsetMs: 0,
              },
            ],
          };
        return {
          events: [{ kind: 'reaction', summary: 'should not commit', ageMs: 0 }],
          messages: [
            {
              author: 'unknown_name',
              text: 'intruder',
              color: '#ffffff',
              offsetMs: 0,
            },
          ],
        };
      },
    };
    const session = new SessionController(
      chat,
      provider,
      clock,
      { ...DEFAULT_PREFERENCES, cycleIntervalMs: 1500 },
      undefined,
      audience,
    );
    session.start('live', 'fake');
    await flush();
    clock.advance(1500);
    await flush();
    expect(session.snapshot().warning).toMatch(/outside the roster/);
    expect(chat.snapshot().messages.map((item) => item.text)).toEqual(['first']);
    expect(session.snapshot().events).toEqual([]);
    session.stop();
  });
});
