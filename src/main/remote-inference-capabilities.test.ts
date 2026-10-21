import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { InferenceCoordinator } from './inference-coordinator';
import { buildUnifiedInferenceRequest } from './unified-inference-request';
import {
  strictProviderSchema,
  readRemoteModelMetadata,
  inspectRemoteModel,
  remoteUnifiedAdapter,
} from './remote-inference-adapter';
import { validateRemoteRequest } from './remote-inference-capabilities';
import { RemoteInferenceStore } from './remote-inference-store';
import {
  effectiveRemoteCapabilities,
  remoteConnectionKey,
  type RemoteConnection,
  type RemoteModelConfiguration,
} from '../shared/remote-inference-contract';
import type { InferenceInput } from './fake-inference';

const connection: RemoteConnection = {
  id: 'c',
  name: 'Server',
  baseUrl: 'http://127.0.0.1:8991/v1',
  credentialMode: 'none',
  protocol: 'chat-completions',
  allowInsecureLan: false,
};
const model: RemoteModelConfiguration = {
  id: 'm',
  name: 'Vision',
  model: 'model-a',
  connectionId: 'c',
  images: true,
  allowRemoteImages: true,
  outputFormat: 'json-schema',
};
const input: InferenceInput = {
  context: 'The guests reunite',
  cycle: 1,
  playbackWindowMs: 3000,
  roster: [{ author: 'alice', color: '#123456' }],
  frames: [
    {
      sourceId: 'camera',
      dataUrl: 'data:image/jpeg;base64,AAAA',
      observedAt: 1000,
      width: 2,
      height: 2,
    },
  ],
};
const request = () => buildUnifiedInferenceRequest(input);
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('remote provider capability and multimodal contracts', () => {
  it('consumes only recognized capability metadata and requires explicit override for contradictory endpoint claims', () => {
    const support = readRemoteModelMetadata({
      id: 'model-a',
      input_modalities: ['text'],
      supported_parameters: ['response_format', 'json_schema', 'temperature'],
      secret: 'do-not-leak',
    });
    expect(readRemoteModelMetadata({ supported_parameters: ['response_format'] })).toMatchObject({
      jsonSchema: false,
      jsonObject: true,
    });
    expect(support).toEqual({
      text: true,
      images: false,
      nativeVideo: false,
      jsonSchema: true,
      jsonObject: true,
      seed: false,
      sampling: true,
    });
    const checked = {
      ...model,
      capabilityEvidence: {
        source: 'metadata' as const,
        connectionKey: remoteConnectionKey(connection),
        model: model.model,
        checkedAt: Date.now(),
        support,
      },
    };
    expect(effectiveRemoteCapabilities(connection, checked).images).toBe(false);
    expect(() => validateRemoteRequest(connection, checked, request())).toThrow(
      /verified image support/,
    );
    expect(() =>
      validateRemoteRequest(
        connection,
        { ...checked, capabilityOverrides: { images: true } },
        request(),
      ),
    ).not.toThrow();
    expect(
      effectiveRemoteCapabilities({ ...connection, baseUrl: 'http://localhost:8991/v1' }, checked)
        .images,
    ).toBe(true);
    expect(effectiveRemoteCapabilities(connection, { ...checked, model: 'model-b' }).images).toBe(
      true,
    );
    expect(
      effectiveRemoteCapabilities(connection, {
        ...checked,
        capabilityEvidence: { ...checked.capabilityEvidence, checkedAt: Date.now() - 90_000_000 },
      }).images,
    ).toBe(true);
  });

  it('retrieves metadata from the exact model route and refuses a mismatched response', async () => {
    const requests: string[] = [];
    const fetcher: typeof fetch = async (resource) => {
      requests.push(String(resource));
      return Response.json({
        id: 'model-a',
        capabilities: { supports_vision: false, supports_seed: true },
      });
    };
    expect(
      await inspectRemoteModel(
        { connection, model, credential: null },
        new AbortController().signal,
        fetcher,
      ),
    ).toEqual({ images: false, seed: true });
    expect(requests[0]).toContain('/v1/models/model-a');
    await expect(
      inspectRemoteModel(
        { connection, model, credential: null },
        new AbortController().signal,
        async () => Response.json({ id: 'wrong', images: true }),
      ),
    ).rejects.toThrow(/different model/);
  });

  it('persists only current probe evidence and rejects asynchronous results after a connection changes', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lc-capability-'));
    dirs.push(dir);
    const store = new RemoteInferenceStore(dir, {
      available: () => false,
      encrypt: () => Buffer.alloc(0),
      decrypt: () => '',
    });
    await store.load();
    await store.putConnection(connection);
    await store.putModel(model);
    const binding = { connectionKey: remoteConnectionKey(connection), model: model.model };
    const saved = await store.recordCapabilities('m', binding, 'probe', {
      text: true,
      jsonSchema: true,
    });
    expect(store.list().models[0].capabilityEvidence).toEqual(saved);
    const metadata = await store.recordCapabilities('m', binding, 'metadata', {
      images: false,
      jsonSchema: false,
    });
    expect(metadata.support).toEqual({ text: true, jsonSchema: true, images: false });
    expect(metadata.sources).toMatchObject({ jsonSchema: 'probe', images: 'metadata' });
    await store.putModel({ ...model, capabilityEvidence: { ...saved, support: { images: true } } });
    expect(store.list().models[0].capabilityEvidence?.support.images).toBe(false);
    await store.putConnection({ ...connection, protocol: 'responses' });
    await expect(store.recordCapabilities('m', binding, 'probe', { images: true })).rejects.toThrow(
      /changed during capability check/,
    );
    expect(
      effectiveRemoteCapabilities(store.list().connections[0], store.list().models[0]).jsonSchema,
    ).toBe(true);
  });

  it('rejects unsupported controls, malformed schemas, partial media and oversized or out-of-order frames', () => {
    const req = request();
    const responses = { ...connection, protocol: 'responses' as const };
    expect(() =>
      validateRemoteRequest(responses, model, {
        ...req,
        sampling: { ...req.sampling, seed: 42, seedMode: 'required' },
      }),
    ).toThrow(/does not support seed/);
    expect(() =>
      validateRemoteRequest(
        connection,
        { ...model, capabilityOverrides: { sampling: false } },
        { ...req, sampling: { ...req.sampling, temperature: 0.1 } },
      ),
    ).toThrow(/sampling temperature/);
    expect(() =>
      validateRemoteRequest(
        connection,
        { ...model, capabilityOverrides: { jsonSchema: false } },
        req,
      ),
    ).toThrow(/strict JSON Schema/);
    expect(() =>
      validateRemoteRequest(connection, model, { ...req, nativeVideo: { sourceRef: 'foo' } }),
    ).toThrow(/Native-video transport/);
    const image = req.content.find((part) => part.type === 'image')!;
    expect(() =>
      validateRemoteRequest(connection, model, {
        ...req,
        content: [{ ...image, dataUrl: 'data:image/jpeg;base64,' }],
      }),
    ).toThrow(/base64/);
    expect(() =>
      validateRemoteRequest(connection, model, {
        ...req,
        content: [image, { ...image, observedAt: 500 }],
      }),
    ).toThrow(/ordered observation timestamps/);
    expect(() =>
      validateRemoteRequest(connection, model, {
        ...req,
        content: Array.from({ length: 17 }, (_, index) => ({ ...image, observedAt: index })),
      }),
    ).toThrow(/at most 16 frames/);
    expect(
      strictProviderSchema({
        type: 'object',
        properties: { ok: { type: 'string' } },
        required: [],
        additionalProperties: false,
      }),
    ).toEqual({
      type: 'object',
      properties: { ok: { type: ['string', 'null'] } },
      required: ['ok'],
      additionalProperties: false,
    });
    expect(() =>
      strictProviderSchema({
        type: 'array',
        items: { type: 'object', properties: {}, required: [], additionalProperties: true },
      }),
    ).toThrow(/additionalProperties/);
  });

  it('keeps semantic validation authoritative and retries malformed or partial structured output without publishing either', async () => {
    const coordinator = new InferenceCoordinator();
    let attempts = 0;
    const result = await coordinator.execute(
      { ...input, frames: [] },
      {
        capabilities: { images: true },
        async complete() {
          attempts++;
          return {
            raw: { status: 'completed' },
            normalized:
              attempts === 1
                ? { events: [], messages: [{ author: 'unknown', text: 'invalid', offsetMs: 0 }] }
                : {
                    events: [],
                    messages: [
                      { author: 'alice', text: 'They are back!', offsetMs: 10, color: '#123456' },
                    ],
                  },
          };
        },
      },
      { signal: new AbortController().signal, maxAttempts: 2 },
    );
    expect(result.attempts).toBe(2);
    expect(result.accepted.messages).toHaveLength(1);
    const failed = new InferenceCoordinator();
    await expect(
      failed.execute(
        { ...input, frames: [] },
        {
          capabilities: { images: true },
          async complete() {
            return { raw: { status: 'partial' }, normalized: { events: 'oops', messages: [] } };
          },
        },
        { signal: new AbortController().signal, maxAttempts: 1 },
      ),
    ).rejects.toThrow();
  });

  it('retries malformed JSON but never accepts a truncated completion', async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return Response.json({
        id: 'test-completion',
        choices: [
          {
            finish_reason: calls === 3 ? 'length' : 'stop',
            message: {
              content:
                calls === 1
                  ? '```json\n{"events":[],"messages":[]}\n```'
                  : JSON.stringify({
                      events: [],
                      messages: [{ author: 'alice', text: 'They are back!', offsetMs: 10 }],
                    }),
            },
          },
        ],
      });
    };
    const adapter = remoteUnifiedAdapter(
      { connection, model: { ...model, outputFormat: 'prompt-json' }, credential: null },
      { roster: input.roster, fetcher },
    );
    const result = await new InferenceCoordinator().execute({ ...input, frames: [] }, adapter, {
      signal: new AbortController().signal,
      maxAttempts: 2,
    });
    expect(result.attempts).toBe(2);
    expect(calls).toBe(2);
    expect(result.accepted.messages).toHaveLength(1);
    await expect(
      new InferenceCoordinator().execute({ ...input, frames: [] }, adapter, {
        signal: new AbortController().signal,
        maxAttempts: 1,
      }),
    ).rejects.toThrow(/did not finish/);
    expect(calls).toBe(3);
  });
});
