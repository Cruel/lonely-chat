import { describe, expect, it, vi } from 'vitest';
import { InferenceCoordinator, type UnifiedInferenceAdapter } from './inference-coordinator';
import { buildUnifiedInferenceRequest } from './unified-inference-request';
import { llamaCppAdapter } from './unified-inference-adapters';
import { nativeChatRequest } from './native-inference';
import type { InferenceInput } from './fake-inference';

const input: InferenceInput = {
  context: 'Two friends reunite at a train station.',
  cycle: 3,
  seed: 123,
  playbackWindowMs: 5000,
  chatActivity: 'normal',
  boundary: { fromSequence: 1, throughSequence: 3, fromMs: 10000, throughMs: 13000 },
  recentTranscripts: [{ source: 'mic', text: 'Welcome back!', observedAt: 12000 }],
  recentEvents: [{ kind: 'context', summary: 'friends separated for years', observedAt: 10000 }],
  roster: [{ author: 'viewer', color: '#112233' }],
  frames: [
    {
      sourceId: 'camera',
      observedAt: 11000,
      mediaTimeMs: 500,
      width: 32,
      height: 32,
      dataUrl: 'data:image/jpeg;base64,AAAA',
    },
    {
      sourceId: 'camera',
      observedAt: 12500,
      mediaTimeMs: 2000,
      width: 32,
      height: 32,
      dataUrl: 'data:image/jpeg;base64,BBBB',
    },
  ],
};

const normalized = {
  events: [{ kind: 'reaction', summary: 'friends meet', ageMs: 500 }],
  messages: [{ author: 'viewer', color: '#112233', text: 'They found each other!', offsetMs: 600 }],
};

describe('Unified Inference Coordinator', () => {
  it('builds ordered timestamped image content with transcripts, history and schema', () => {
    const request = buildUnifiedInferenceRequest(input);
    expect(request.role).toBe('unified');
    expect(request.content.map((part) => part.type)).toEqual([
      'text',
      'text',
      'image',
      'text',
      'image',
    ]);
    expect(request.content[2]).toMatchObject({
      type: 'image',
      sourceId: 'camera',
      observedAt: 11000,
      mediaTimeMs: 500,
    });
    expect(request.content[4]).toMatchObject({
      type: 'image',
      sourceId: 'camera',
      observedAt: 12500,
      mediaTimeMs: 2000,
    });
    expect(request.content[0]).toMatchObject({
      text: expect.stringContaining('Welcome back!'),
    });
    expect(request.content[0]).toMatchObject({
      text: expect.stringContaining('friends separated for years'),
    });
    expect(request.response.schema.properties.messages.items.properties.author.enum).toEqual([
      'viewer',
      '__any__',
    ]);
  });

  it('accepts Events and Chat atomically after protocol-independent completion', async () => {
    const adapter: UnifiedInferenceAdapter = {
      capabilities: { images: true },
      complete: vi.fn(async () => ({
        raw: { usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 } },
        normalized,
      })),
    };
    const result = await new InferenceCoordinator().execute(input, adapter, {
      signal: new AbortController().signal,
      playbackWindowMs: 500,
    });
    expect(result.accepted.events).toEqual([
      { kind: 'reaction', summary: 'friends meet', observedAt: 12500 },
    ]);
    expect(result.accepted.messages).toEqual([
      { author: 'viewer', color: '#112233', text: 'They found each other!', offsetMs: 500 },
    ]);
    expect(result.usage).toEqual({ promptTokens: 50, completionTokens: 25, totalTokens: 75 });
  });

  it('retries at most three times with the exact same immutable request snapshot', async () => {
    const snapshots: unknown[] = [];
    let attempted = 0;
    const adapter: UnifiedInferenceAdapter = {
      capabilities: { images: true },
      complete: async (request) => {
        snapshots.push(request);
        expect(Object.isFrozen(request)).toBe(true);
        expect(Object.isFrozen(request.content[2])).toBe(true);
        attempted++;
        if (attempted < 3) throw new Error('temporary transport failure');
        return { raw: normalized, normalized };
      },
    };
    const attemptedErrors: number[] = [];
    const result = await new InferenceCoordinator().execute(input, adapter, {
      signal: new AbortController().signal,
      maxAttempts: 3,
      onAttempt: (attempt) => attemptedErrors.push(attempt),
    });
    expect(attemptedErrors).toEqual([1, 2]);
    expect(result.attempts).toBe(3);
    expect(snapshots[0]).toBe(snapshots[1]);
    expect(snapshots[1]).toBe(snapshots[2]);
    expect(result.request.sampling.seed).toBe(123);
    expect(input.frames?.[0].dataUrl).toBe('data:image/jpeg;base64,AAAA');
  });

  it('rejects malformed batches rather than publishing partially valid Events', async () => {
    const adapter: UnifiedInferenceAdapter = {
      capabilities: { images: true },
      complete: async () => ({
        raw: {},
        normalized: {
          events: [{ kind: 'reaction', summary: 'bad', ageMs: -10 }],
          messages: normalized.messages,
        },
      }),
    };
    await expect(
      new InferenceCoordinator().execute(input, adapter, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/invalid event/);
  });

  it('gates image modality before calling text-only providers', async () => {
    const complete = vi.fn(async () => ({ raw: normalized, normalized }));
    await expect(
      new InferenceCoordinator().execute(
        input,
        {
          capabilities: { images: false },
          complete,
        },
        { signal: new AbortController().signal },
      ),
    ).rejects.toThrow(/does not accept image/);
    expect(complete).not.toHaveBeenCalled();
  });

  it('revokes publication authority on Stop even when a provider ignores abort', async () => {
    let complete!: (value: { raw: unknown; normalized: unknown }) => void;
    const pending = new Promise<{ raw: unknown; normalized: unknown }>((resolve) => {
      complete = resolve;
    });
    const coordinator = new InferenceCoordinator();
    const accepted = vi.fn();
    const task = coordinator.execute(
      input,
      {
        capabilities: { images: true },
        complete: () => pending,
      },
      {
        signal: new AbortController().signal,
        onParsed: accepted,
      },
    );
    coordinator.cancelActive();
    complete({ raw: normalized, normalized });
    await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    expect(accepted).not.toHaveBeenCalled();
  });

  it('permits native video only for capable adapters, and preserves the requested source', async () => {
    const complete = vi.fn(async (_request: unknown) => ({
      raw: {},
      normalized,
      usage: { promptTokens: 7, completionTokens: 9, totalTokens: 16 },
    }));
    const coordinator = new InferenceCoordinator();
    const signal = new AbortController().signal;
    await expect(
      coordinator.execute(
        input,
        {
          capabilities: { images: true },
          complete,
        },
        { signal, nativeVideoRef: 'video-source' },
      ),
    ).rejects.toThrow(/does not support native video/);
    expect(complete).not.toHaveBeenCalled();
    const result = await coordinator.execute(
      input,
      {
        capabilities: { images: true, nativeVideo: true },
        complete,
      },
      { signal, nativeVideoRef: 'video-source' },
    );
    expect(result.request.nativeVideo).toEqual({ sourceRef: 'video-source' });
    expect(complete.mock.calls[0]?.[0]).toMatchObject({
      nativeVideo: { sourceRef: 'video-source' },
    });
    expect(result.usage).toEqual({ promptTokens: 7, completionTokens: 9, totalTokens: 16 });
  });

  it('uses the identical Unified request when translating to llama.cpp', async () => {
    const calls: unknown[] = [];
    const adapter = llamaCppAdapter(
      {
        async completeSimulationRequest(_input, request) {
          calls.push(request);
          return {
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: JSON.stringify({
                    events: normalized.events,
                    messages: [{ author: 'viewer', text: 'They found each other!', offsetMs: 600 }],
                  }),
                },
              },
            ],
            usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
          };
        },
      },
      input,
    );
    const result = await new InferenceCoordinator().execute(input, adapter, {
      signal: new AbortController().signal,
    });
    expect(calls).toEqual([nativeChatRequest(input)]);
    expect(result.accepted.messages[0].color).toBe('#112233');
    expect(result.usage?.totalTokens).toBe(15);
  });
});
