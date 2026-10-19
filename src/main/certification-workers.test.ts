import { expect, it } from 'vitest';
import {
  CertificationSpeechWorker,
  certificationPlaygroundProvider,
} from './certification-workers';

it('provides deterministic portable Playground output and isolates an intentional worker failure', async () => {
  const provider = certificationPlaygroundProvider();
  const signal = new AbortController().signal;
  const freeform = await provider.completeFreeform(
    {
      modelId: 'cert-worker',
      systemPrompt: 'private',
      userPrompt: 'verify me',
      seed: 17,
      temperature: 0,
      topP: 1,
      topK: 1,
      maxTokens: 24,
    },
    signal,
  );
  expect(freeform).toMatchObject({
    content: 'fixture-freeform:verify me',
    effectiveSeed: 17,
    finishReason: 'stop',
  });
  const response = (await provider.completeSimulationRequest?.(
    {
      context: 'scene',
      cycle: 1,
      roster: [{ author: 'pixelpilot', color: '#abcdef' }],
    },
    { seed: 21 },
    signal,
  )) as {
    choices: { message: { content: string } }[];
  };
  const result = JSON.parse(response.choices[0].message.content);
  expect(result.events[0].summary).toBe('certified structured output');
  expect(result.messages[0].author).toBe('pixelpilot');
  await expect(
    provider.completeSimulationRequest?.({ context: 'cert-failure', cycle: 1 }, {}, signal),
  ).rejects.toThrow(/failed intentionally/);
  await expect(
    provider.completeFreeform(
      {
        modelId: 'cert-failure',
        systemPrompt: '',
        userPrompt: '',
        temperature: 0,
        topP: 1,
        topK: 1,
        maxTokens: 8,
        seed: 0,
      },
      signal,
    ),
  ).rejects.toThrow(/failed intentionally/);
});

it('uses deterministic PCM-only speech fixture and publishes lifecycle transitions', async () => {
  const worker = new CertificationSpeechWorker();
  const phases: string[] = [];
  const off = worker.subscribe((status) => phases.push(status.phase));
  await worker.start();
  expect(worker.snapshot().phase).toBe('ready');
  expect(await worker.transcribe(new Float32Array(1600))).toBe('certified speech from PCM');
  await expect(worker.transcribe(new Float32Array(100))).rejects.toThrow(
    /Insufficient decoded PCM/,
  );
  await worker.shutdown();
  off();
  expect(phases).toEqual(['ready', 'stopped']);
});
