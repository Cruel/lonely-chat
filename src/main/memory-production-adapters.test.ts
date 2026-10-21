import { expect, it, vi } from 'vitest';
import { NarrativeMemory } from './narrative-memory';
import { llamaCppAdapter } from './unified-inference-adapters';
import { remoteUnifiedAdapter } from './remote-inference-adapter';
import type {
  RemoteConnection,
  RemoteModelConfiguration,
} from '../shared/remote-inference-contract';

const policy = { enabled: true, intervalMs: 1000, maxCharacters: 512, expireAfterMs: 0 };
const input = { context: 'A race', cycle: 1 };
const summary = { summary: 'At 100ms, the leader crossed the finish line.' };

it('accepts standalone Memory JSON through the production llama.cpp adapter', async () => {
  const submit = vi.fn(async () => ({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(summary) } }],
  }));
  const memory = new NarrativeMemory();
  memory.observe('Leader crossed the finish line', 100);
  expect(
    await memory.update(
      1000,
      policy,
      llamaCppAdapter(
        { completeSimulationRequest: (_input, _request, _signal) => submit() },
        input,
      ),
      new AbortController().signal,
    ),
  ).toBe(true);
  expect(memory.snapshot(1000, policy)?.text).toBe(summary.summary);
  expect(submit).toHaveBeenCalledTimes(1);
});

it('accepts standalone Memory JSON through the production remote SDK adapter', async () => {
  const connection: RemoteConnection = {
    id: 'conn',
    name: 'Local fixture',
    baseUrl: 'http://127.0.0.1:1234/v1',
    credentialMode: 'none',
    allowInsecureLan: false,
    protocol: 'chat-completions',
  };
  const model: RemoteModelConfiguration = {
    id: 'model',
    connectionId: 'conn',
    name: 'Model',
    model: 'local-model',
    images: false,
    allowRemoteImages: false,
    outputFormat: 'prompt-json',
  };
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          id: 'mem-1',
          choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(summary) } }],
          usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  const memory = new NarrativeMemory();
  memory.observe('Leader crossed the finish line', 100);
  const adapter = remoteUnifiedAdapter(
    { connection, model, credential: null },
    { fetcher: fetcher as typeof fetch },
  );
  expect(await memory.update(1000, policy, adapter, new AbortController().signal)).toBe(true);
  expect(memory.snapshot(1000, policy)?.text).toBe(summary.summary);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
