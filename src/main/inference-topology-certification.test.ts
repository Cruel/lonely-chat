import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { ChatService } from './chat-service';
import { FakeInference } from './fake-inference';
import { SessionController } from './session-controller';
import { FakeClock, flushMicrotasks } from './test-support/fake-clock';
import { remoteUnifiedAdapter } from './remote-inference-adapter';
import type { UnifiedInferenceAdapter } from './inference-coordinator';
import type { InferenceProfile } from '../shared/inference-profile-contract';
import type { RemoteSelection } from './remote-inference-adapter';

const jpeg = 'data:image/jpeg;base64,' +
  readFileSync(new URL('../../tests/fixtures/playground-red.jpg', import.meta.url)).toString('base64');
const visual = {
  sceneState: 'The runner crosses the finish line.',
  events: [{ kind: 'reaction', summary: 'Runner wins the race', ageMs: 0 }],
  messages: [],
};
const chatter = {
  events: [],
  messages: [{ author: 'pixelpilot', text: 'What a finish!', color: '#bba5ff', offsetMs: 0 }],
};
const profile = (
  topology: 'split' | 'hybrid',
  chatKind: 'local' | 'remote',
): InferenceProfile => ({
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  revision: 1,
  name: topology + '-' + chatKind,
  values: {
    topology,
    roles: {
      observer: { kind: 'local', modelId: 'fixture-vision' },
      chat: { kind: chatKind, modelId: chatKind === 'local' ? 'fixture-vision' : 'compatible-chat' },
    },
    stageDefaults: {},
    architecture: {
      execution: 'sequential', hybridMaxImages: topology === 'hybrid' ? 1 : 0,
      remoteChatImagesConsent: topology === 'hybrid',
    },
  },
});

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) =>
    new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function compatibleFixture(requests: unknown[]): Promise<RemoteSelection> {
  const server = createServer(async (request, response) => {
    const bytes: Buffer[] = [];
    for await (const chunk of request) bytes.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(bytes).toString()));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'fixture-response',
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(chatter) } }],
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return {
    connection: {
      id: 'compatible', name: 'Local compatible server',
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      protocol: 'chat-completions', credentialMode: 'none', allowInsecureLan: false,
    },
    model: {
      id: 'compatible-chat', connectionId: 'compatible', name: 'Chat', model: 'fixture-chat',
      images: true, allowRemoteImages: true, outputFormat: 'json-schema',
    },
    credential: null,
  };
}

const localVision: UnifiedInferenceAdapter = {
  capabilities: { images: true },
  complete: async () => ({ raw: visual, normalized: visual }),
};

async function startRecorded(
  topology: 'split' | 'hybrid',
  chatKind: 'local' | 'remote',
  chatAdapter: UnifiedInferenceAdapter,
  visionAdapter: UnifiedInferenceAdapter = localVision,
) {
  const clock = new FakeClock();
  const chat = new ChatService();
  const session = new SessionController(chat, undefined, clock, {
    cycleIntervalMs: 1500, baselineMs: 500,
    videoMinFrames: 1, videoMaxFrames: 2, videoCaptureIntervalMs: 250,
  }, new FakeInference());
  const observer = vi.fn(visionAdapter.complete);
  session.selectVideoSource('recorded:video');
  session.configureSplit(() => ({
    vision: { capabilities: { images: true }, complete: observer },
    chat: chatAdapter,
  }), chatKind === 'local');
  session.start('Follow the race', chatKind === 'local' ? 'native' : 'remote', 'fixture-vision',
    { inputMode: 'recorded', publishToOverlay: false }, undefined, undefined,
    profile(topology, chatKind));
  session.recordVideoFrame({
    sourceId: 'recorded:video', observedAt: clock.wallNow(),
    width: 4, height: 4, dataUrl: jpeg,
  });
  clock.advance(500);
  await flushMicrotasks();
  return { clock, chat, session, observer };
}

describe('integrated provider/topology certification without paid models or GPU', () => {
  it('runs both local Split roles through a shared deterministic adapter', async () => {
    const roles: string[] = [];
    const shared: UnifiedInferenceAdapter = {
      capabilities: { images: true },
      complete: vi.fn(async (request) => {
        roles.push(request.role);
        const reply = request.role === 'vision' ? visual : chatter;
        return { raw: reply, normalized: reply };
      }),
    };
    const result = await startRecorded('split', 'local', shared, shared);
    await vi.waitFor(async () => {
      await flushMicrotasks();
      expect(result.chat.snapshot().messages.map((message) => message.text)).toEqual(['What a finish!']);
    });
    expect(roles).toEqual(['vision', 'chat']);
    expect(result.session.snapshot().events).toEqual(expect.arrayContaining([
      expect.objectContaining({ summary: 'Runner wins the race' }),
    ]));
    expect(result.chat.publicSnapshot().messages).toHaveLength(0);
    result.session.stop();
    await result.session.terminate();
  });

  for (const topology of ['split', 'hybrid'] as const) {
    it(`runs local Vision + compatible remote Chat through a private ${topology} recorded Run`, async () => {
      const requests: unknown[] = [];
      const selection = await compatibleFixture(requests);
      const adapter = remoteUnifiedAdapter(selection);
      const result = await startRecorded(topology, 'remote', adapter);
      try {
        await vi.waitFor(async () => {
          await flushMicrotasks();
          expect(result.chat.snapshot().messages.map((message) => message.text)).toEqual(['What a finish!']);
        });
        expect(result.observer).toHaveBeenCalledOnce();
        expect(result.session.snapshot().events).toEqual(expect.arrayContaining([
          expect.objectContaining({ summary: 'Runner wins the race' }),
        ]));
        expect(result.chat.publicSnapshot().messages).toHaveLength(0);
        expect(requests).toHaveLength(1);
        const encoded = JSON.stringify(requests[0]);
        expect(encoded).toContain('Runner wins the race');
        if (topology === 'split') expect(encoded).not.toContain('data:image/jpeg;base64,');
        else expect(encoded).toContain('data:image/jpeg;base64,');
        const traces = result.session.trace.list().attempts;
        expect(traces.some((attempt) => attempt.role === 'vision')).toBe(true);
        expect(traces.some((attempt) => attempt.role === 'chat')).toBe(true);
      } finally {
        result.session.stop();
        await result.session.terminate();
      }
    });
  }
});
