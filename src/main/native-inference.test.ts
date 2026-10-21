import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  NativeInference,
  extractNativeChat,
  nativeChatRequest,
  nativeFreeformRequest,
  withNativeVideoData,
  withNativeVideoPlaceholder,
  VIDEO_DATA_PLACEHOLDER,
} from './native-inference';
import { PrivateInferenceError } from './private-inference-error';
import { AUTHOR_PLACEHOLDER } from '../shared/audience-contract';
import { DEFAULT_PREFERENCES } from '../shared/session-contract';
import { parseInferenceResult } from './fake-inference';
import { bundledAcceleratedLlamaServer, bundledLlamaServer } from './native-runtime-path';

const providers: NativeInference[] = [];
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.stop()));
});

const childScript = `
import { createServer } from 'node:http';
const port = Number(process.argv[1]);
const key = process.argv[2];
const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  if (request.url === '/health') {
    response.end(JSON.stringify({status:'ok'}));
    return;
  }
  if (request.url === '/props' && request.headers.authorization === 'Bearer ' + key) {
    response.end(JSON.stringify({modalities:{vision:true}}));
    return;
  }
  if (request.url !== '/v1/chat/completions' || request.headers.authorization !== 'Bearer ' + key) {
    response.writeHead(401);
    response.end(JSON.stringify({error:'unauthorized'}));
    return;
  }
  let body='';
  for await (const chunk of request) body += chunk;
  const parsed = JSON.parse(body);
  if (parsed.messages[0].content.startsWith('Generate distinct')) {
    if (parsed.seed !== 2345 || parsed.temperature !== 0.85 || parsed.max_tokens !== 1024) {
      response.writeHead(422);
      response.end(JSON.stringify({error:'incorrect roster sampling'}));
      return;
    }
    response.end(JSON.stringify({choices:[{finish_reason:'stop', message:{content:JSON.stringify({names:['TestFox','TestCat']})}}]}));
    return;
  }
  if (!parsed.response_format) {
    if (
      parsed.messages[0]?.content !== 'You are a poet' ||
      parsed.messages[1]?.content !== 'Write a haiku' ||
      parsed.temperature !== 0.35 || parsed.top_p !== 0.75 ||
      parsed.top_k !== 22 || parsed.max_tokens !== 96 || parsed.seed !== 12345 ||
      parsed.stream !== false
    ) {
      response.writeHead(422);
      response.end(JSON.stringify({error:'incorrect Freeform fields'}));
      return;
    }
    response.end(JSON.stringify({choices:[{finish_reason:'stop', message:{content:'An original haiku'}}],
      usage:{prompt_tokens:10,completion_tokens:6,total_tokens:16}}));
    return;
  }
  if (parsed.response_format?.type !== 'json_object' || parsed.messages[1].content.indexOf('campfire') < 0 ||
      parsed.seed !== 314 || parsed.temperature !== 0.7 || parsed.max_tokens !== 2048) {
    response.writeHead(400);
    response.end(JSON.stringify({error:'invalid structured request'}));
    return;
  }
  response.end(JSON.stringify({choices:[{finish_reason:'stop', message:{content:JSON.stringify({
    events:[{kind:'context',summary:'Campfire is lit',ageMs:100}],
    messages:[{author:'pixelpilot',text:'warm fire',offsetMs:0}]
  })}}]}));
});
server.listen(port,'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
`;

describe('native llama.cpp adapter', () => {
  it('transports native video through the private worker without exposing its base64 in request previews', async () => {
    const token = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const payloads: unknown[] = [];
    const launches: string[][] = [];
    const worker = new NativeInference({
      executable: process.execPath,
      resolveModel: async () => ({
        modelPath: '/model.gguf',
        projectorPath: '/projector.gguf',
      }),
      videoFfmpegDir: () => '/configured/ffmpeg',
      videoPreferences: {
        fps: 8,
        timestampIntervalMs: 2000,
        maxClipSizeMiB: 50,
        maxClipDurationSeconds: 30,
      },
      resolveVideo: async (selected, limits) => {
        expect(selected).toBe(token);
        expect(limits).toMatchObject({ fps: 8, maxClipSizeMiB: 50 });
        return 'RklYVFVSRQ==';
      },
      launch: (_binary, args, options) => {
        launches.push([...args]);
        return spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            childScript,
            args[args.indexOf('--port') + 1],
            args[args.indexOf('--api-key') + 1],
          ],
          options,
        );
      },
      fetcher: async (url, options) => {
        if (!String(url).endsWith('/v1/chat/completions')) return fetch(url, options);
        payloads.push(JSON.parse(options?.body as string));
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'Video described' } }],
          }),
          { status: 200 },
        );
      },
    });
    providers.push(worker);
    const freeform = {
      modelId: 'video',
      systemPrompt: '',
      userPrompt: 'Summarize movement',
      temperature: 0.7,
      topP: 0.95,
      topK: 40,
      maxTokens: 32,
      seed: 123,
      videoMode: 'native-video' as const,
      video: { token },
      videoOptions: {
        fps: 8,
        timestampIntervalMs: 2000,
        maxClipSizeMiB: 50,
        maxClipDurationSeconds: 30,
      },
    };
    const preview = nativeFreeformRequest(freeform);
    expect(JSON.stringify(preview)).toContain(VIDEO_DATA_PLACEHOLDER);
    const result = await worker.completeFreeform(freeform, new AbortController().signal);
    expect(result.content).toBe('Video described');
    const experimentPreview = withNativeVideoPlaceholder(
      nativeChatRequest({
        context: 'game',
        cycle: 1,
      }),
    );
    await worker.completeSimulationRequest(
      { context: 'game', cycle: 1 },
      experimentPreview,
      new AbortController().signal,
      token,
      freeform.videoOptions,
    );
    expect(launches[0].slice(-2)).not.toEqual(['--video-ffmpeg-dir', '/configured/ffmpeg']);
    expect(launches[0]).toContain('--video-ffmpeg-dir');
    expect(launches[0][launches[0].indexOf('--video-ffmpeg-dir') + 1]).toBe('/configured/ffmpeg');
    expect(launches[0][launches[0].indexOf('--video-fps') + 1]).toBe('8');
    expect(launches[0][launches[0].indexOf('--video-timestamp-interval') + 1]).toBe('2000');
    for (const sent of payloads) {
      expect(JSON.stringify(sent)).toContain('"input_video"');
      expect(JSON.stringify(sent)).toContain('RklYVFVSRQ==');
      expect(JSON.stringify(sent)).not.toContain(VIDEO_DATA_PLACEHOLDER);
    }
    expect(JSON.stringify(experimentPreview)).not.toContain('RklYVFVSRQ==');
    expect(withNativeVideoData(preview, 'RklYVFVSRQ==')).toMatchObject({
      messages: [{ role: 'user', content: expect.any(Array) }],
    });
  });

  it('creates bounded structured prompts and rejects untrusted output atomically', () => {
    const prompt = nativeChatRequest({ context: 'campfire', cycle: 1 });
    expect(prompt.response_format.type).toBe('json_object');
    expect(prompt.max_tokens).toBe(2048);
    expect(prompt).not.toHaveProperty('json_schema');
    expect(
      prompt.response_format.schema.properties.messages.items.properties.author.enum,
    ).toContain('pixelpilot');
    const good = extractNativeChat({
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              events: [{ kind: 'context', summary: 'lit fire', ageMs: 500 }],
              messages: [{ author: 'pixelpilot', text: 'hello', offsetMs: 0 }],
            }),
          },
        },
      ],
    });
    const parsed = parseInferenceResult(good, 1000);
    expect(parsed.events[0].observedAt).toBe(500);
    expect(parsed.messages[0].color).toBe('#bba5ff');
    expect(() =>
      extractNativeChat({
        choices: [{ finish_reason: 'length', message: { content: '{}' } }],
        usage: {
          prompt_tokens: 560,
          completion_tokens: 2048,
          completion_tokens_details: { reasoning_tokens: 1800 },
        },
      }),
    ).toThrow(
      /finish_reason="length".*2048-token output limit.*prompt=560, completion=2048, reasoning=1800/,
    );
    expect(() =>
      extractNativeChat({
        choices: [{ finish_reason: 'content_filter', message: { content: null } }],
      }),
    ).toThrow(/finish_reason="content_filter".*filtering/);
    expect(() =>
      extractNativeChat({
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: JSON.stringify({
                events: [],
                messages: [{ author: 'unknown', text: 'bad', offsetMs: 0 }],
              }),
            },
          },
        ],
      }),
    ).toThrow(/outside the configured roster/);
    expect(() =>
      parseInferenceResult(
        {
          events: [{ kind: 'context', summary: 'ok', ageMs: -1 }],
          messages: [{ author: 'pixelpilot', text: 'hello', color: '#bba5ff', offsetMs: 0 }],
        },
        1000,
      ),
    ).toThrow(/invalid event/);
  });

  it('uses dynamic roster grammar and preserves placeholders for the audience service', () => {
    const roster = [
      { author: 'ChatFox', color: '#123456' },
      { author: 'ChatCat', color: '#abcdef' },
    ];
    const prompt = nativeChatRequest({
      context: 'campfire',
      cycle: 2,
      roster,
      chatActivity: 'quiet',
      recentChat: [{ author: 'ChatFox', text: 'first', presentedAt: 123 }],
    });
    expect(prompt.response_format.schema.properties.messages.maxItems).toBe(2);
    expect(prompt.response_format.schema.properties.messages.items.properties.author.enum).toEqual([
      'ChatFox',
      'ChatCat',
      AUTHOR_PLACEHOLDER,
    ]);
    const payload = {
      choices: [
        {
          finish_reason: 'stop',
          message: {
            content: JSON.stringify({
              events: [],
              messages: [{ author: AUTHOR_PLACEHOLDER, text: 'hello', offsetMs: 0 }],
            }),
          },
        },
      ],
    };
    expect(extractNativeChat(payload, roster)).toMatchObject({
      messages: [{ author: AUTHOR_PLACEHOLDER, color: '#000000' }],
    });
    expect(() =>
      extractNativeChat(
        {
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({
                  events: [],
                  messages: [{ author: 'unknown', text: 'bad', offsetMs: 0 }],
                }),
              },
            },
          ],
        },
        roster,
      ),
    ).toThrow(/outside the configured roster/);
  });

  it('captures plaintext HTTP errors and invalid JSON with private transport status', async () => {
    const bodies = [
      new Response('private gateway error', { status: 503 }),
      new Response('{"choices":[', { status: 200 }),
    ];
    const provider = new NativeInference({
      executable: process.execPath,
      resolveModel: async () => ({ modelPath: '/managed/other.gguf', projectorPath: null }),
      launch: (_binary, args, options) =>
        spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            childScript,
            args[args.indexOf('--port') + 1],
            args[args.indexOf('--api-key') + 1],
          ],
          options,
        ),
      fetcher: async (url, options) =>
        String(url).endsWith('/v1/chat/completions') ? bodies.shift()! : fetch(url, options),
    });
    providers.push(provider);
    const input = { context: 'recorded test', cycle: 1 };
    const request = nativeChatRequest(input);
    const errors: PrivateInferenceError[] = [];
    for (const _case of [0, 1]) {
      const error = await provider
        .completeSimulationRequest(input, request, new AbortController().signal)
        .catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(PrivateInferenceError);
      errors.push(error as PrivateInferenceError);
    }
    expect(errors[0].diagnosticDetails).toEqual({
      httpStatus: 503,
      responseBody: 'private gateway error',
    });
    expect(errors[1].diagnosticDetails).toEqual({
      httpStatus: 200,
      responseBody: '{"choices":[',
    });
    expect(errors[1].message).toContain('malformed HTTP JSON');
    expect(errors[0].message).not.toContain('private gateway error');
  });

  it('runs genuine freeform chat completions with seed, sampling and usage via authenticated native HTTP', async () => {
    const provider = new NativeInference({
      executable: process.execPath,
      resolveModel: async () => ({ modelPath: '/managed/other.gguf', projectorPath: null }),
      launch: (_binary, args, options) => {
        const port = args[args.indexOf('--port') + 1];
        const key = args[args.indexOf('--api-key') + 1];
        return spawn(
          process.execPath,
          ['--input-type=module', '-e', childScript, port, key],
          options,
        );
      },
    });
    providers.push(provider);
    const request = {
      modelId: 'other',
      systemPrompt: 'You are a poet',
      userPrompt: 'Write a haiku',
      temperature: 0.35,
      topP: 0.75,
      topK: 22,
      maxTokens: 96,
      seed: 12345,
    };
    const result = await provider.completeFreeform(request, new AbortController().signal);
    expect(result).toMatchObject({
      effectiveSeed: 12345,
      content: 'An original haiku',
      finishReason: 'stop',
      usage: { promptTokens: 10, completionTokens: 6, totalTokens: 16 },
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // Server checks exact fields. A rejected HTTP request remains a visible error
    // and does not permanently poison the worker; a second request can succeed.
    const rejected = await provider
      .completeFreeform({ ...request, topK: 30 }, new AbortController().signal)
      .catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(PrivateInferenceError);
    expect((rejected as PrivateInferenceError).message).toContain('HTTP 422');
    expect((rejected as PrivateInferenceError).message).not.toContain('incorrect Freeform fields');
    expect((rejected as PrivateInferenceError).diagnosticDetails).toMatchObject({
      httpStatus: 422,
      responseBody: { error: 'incorrect Freeform fields' },
    });
    expect((await provider.completeFreeform(request, new AbortController().signal)).content).toBe(
      'An original haiku',
    );
  });

  it('submits the selected JPEG bytes, order and timestamps to the authenticated multimodal worker', async () => {
    const red =
      'data:image/jpeg;base64,' +
      readFileSync('tests/fixtures/playground-red.jpg').toString('base64');
    const blue =
      'data:image/jpeg;base64,' +
      readFileSync('tests/fixtures/playground-blue.jpg').toString('base64');
    const frames = [
      { sourceId: 'video:clip', width: 4, height: 4, dataUrl: blue, mediaTimeMs: 750 },
      { sourceId: 'video:clip', width: 4, height: 4, dataUrl: red, mediaTimeMs: 9000 },
    ];
    const requests: unknown[] = [];
    const frameLaunches: string[][] = [];
    const provider = new NativeInference({
      executable: process.execPath,
      resolveModel: async () => ({
        modelPath: '/managed/vision.gguf',
        projectorPath: '/managed/mmproj.gguf',
      }),
      resourcePreferences: () => ({ ...DEFAULT_PREFERENCES, imageMaxTokens: 128 }),
      launch: (_binary, args, options) => {
        frameLaunches.push([...args]);
        return spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            childScript,
            args[args.indexOf('--port') + 1],
            args[args.indexOf('--api-key') + 1],
          ],
          options,
        );
      },
      fetcher: async (url, options) => {
        if (!String(url).endsWith('/v1/chat/completions')) return fetch(url, options);
        requests.push(JSON.parse(options?.body as string));
        return new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'stop', message: { content: 'Frame order received' } }],
            usage: { prompt_tokens: 77, completion_tokens: 4, total_tokens: 81 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      },
    });
    providers.push(provider);
    const result = await provider.completeFreeform(
      {
        modelId: 'vision',
        systemPrompt: 'Look carefully',
        userPrompt: 'Compare frames',
        temperature: 0.7,
        topP: 0.95,
        topK: 40,
        maxTokens: 256,
        seed: 123,
        frames,
      },
      new AbortController().signal,
    );
    expect(
      frameLaunches[0].slice(
        frameLaunches[0].indexOf('--image-max-tokens'),
        frameLaunches[0].indexOf('--image-max-tokens') + 2,
      ),
    ).toEqual(['--image-max-tokens', '128']);
    expect(result.content).toBe('Frame order received');
    expect(result.usage?.totalTokens).toBe(81);
    const transport = requests[0] as {
      messages: {
        content: string | { type: string; text?: string; image_url?: { url: string } }[];
      }[];
    };
    const parts = transport.messages[1].content;
    expect(Array.isArray(parts)).toBe(true);
    if (!Array.isArray(parts)) throw new Error('Multimodal body expected');
    expect(parts.filter((part) => part.image_url).map((part) => part.image_url?.url)).toEqual([
      blue,
      red,
    ]);
    expect(parts.map((part) => part.text).filter(Boolean)).toEqual([
      'Compare frames',
      'Selected frame 1, source=video:clip, mediaTimeMs=750',
      'Selected frame 2, source=video:clip, mediaTimeMs=9000',
    ]);
  });

  it('starts a private server, awaits health, authorizes completion and stops the process', async () => {
    let launchedArgs: string[] = [];
    const provider = new NativeInference({
      executable: process.execPath,
      resolveModel: async () => ({
        modelPath: '/installed/weights.gguf',
        projectorPath: '/installed/mmproj.gguf',
      }),
      launch: (_binary, args, options) => {
        launchedArgs = [...args];
        const port = args[args.indexOf('--port') + 1];
        const key = args[args.indexOf('--api-key') + 1];
        return spawn(
          process.execPath,
          ['--input-type=module', '-e', childScript, port, key],
          options,
        );
      },
    });
    providers.push(provider);
    const transitions: string[] = [];
    provider.subscribe((status) => transitions.push(status.phase));
    expect(provider.snapshot().phase).toBe('stopped');
    expect(
      await provider.generateRoster(2, ['ExcludedName'], new AbortController().signal, 2345),
    ).toEqual(['TestFox', 'TestCat']);
    const transportStages: Array<{ stage: string; value: unknown }> = [];
    const result = await provider.generate(
      { context: 'campfire', cycle: 1, seed: 314 },
      new AbortController().signal,
      (stage, value) => transportStages.push({ stage, value }),
    );
    expect(transportStages.map((item) => item.stage)).toEqual([
      'request',
      'response',
      'normalized',
    ]);
    expect(transportStages[0].value).toMatchObject({ stream: false, seed: 314 });
    expect(transportStages[1].value).toMatchObject({ choices: [{ finish_reason: 'stop' }] });
    expect(transportStages[2].value).toEqual(result);
    expect(parseInferenceResult(result, 1000).messages[0].text).toBe('warm fire');
    expect(transitions).toEqual(['loading', 'ready']);
    expect(launchedArgs).toContain('--no-webui');
    expect(
      launchedArgs.slice(
        launchedArgs.indexOf('--reasoning'),
        launchedArgs.indexOf('--reasoning') + 2,
      ),
    ).toEqual(['--reasoning', 'off']);
    // Current pinned llama-server uses --load-mode; --no-mmap was removed upstream.
    expect(launchedArgs).not.toContain('--no-mmap');
    expect(
      launchedArgs.slice(launchedArgs.indexOf('--host'), launchedArgs.indexOf('--host') + 2),
    ).toEqual(['--host', '127.0.0.1']);
    expect(launchedArgs).toContain('--mmproj');
    const port = launchedArgs[launchedArgs.indexOf('--port') + 1];
    const anonymous = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify(nativeChatRequest({ context: 'campfire', cycle: 1 })),
    });
    expect(anonymous.status).toBe(401);
    await Promise.all([provider.stop(), provider.stop()]);
    expect(provider.snapshot().phase).toBe('stopped');
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
    await provider.prepare(new AbortController().signal);
    expect(provider.snapshot().phase).toBe('ready');
    expect(transitions).toEqual(['loading', 'ready', 'stopped', 'loading', 'ready']);
    await provider.stop();
  });

  it('refuses implicit CPU fallback for pinned local Split workers', async () => {
    const launch = vi.fn();
    const provider = new NativeInference({
      executable: process.execPath,
      resolveModel: async () => ({ modelPath: '/fixture.gguf', projectorPath: null }),
      resourcePreferences: () => ({
        ...DEFAULT_PREFERENCES,
        computeBackend: 'cuda',
        gpuOffloadLayers: 16,
        vramBudgetMiB: 4096,
      }),
      probeDevices: async () => [],
      forbidCpuFallback: true,
      launch,
    });
    providers.push(provider);
    await expect(provider.prepare(new AbortController().signal)).rejects.toThrow(
      'Explicitly select CPU',
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it('applies backend/resource settings and reports unavailable GPU fallback rather than inventing quotas', async () => {
    const launches: string[][] = [];
    const selected = {
      ...DEFAULT_PREFERENCES,
      computeBackend: 'cuda' as const,
      ramBudgetMiB: 1024,
      vramBudgetMiB: 4096,
      gpuComputeTargetPercent: 40,
      cpuThreads: 7,
      contextTokens: 42000,
      imageMaxTokens: 512,
      gpuOffloadLayers: 16,
    };
    const provider = new NativeInference({
      executable: process.execPath,
      resolveModel: async () => ({ modelPath: '/fixture.gguf', projectorPath: null }),
      resourcePreferences: () => selected,
      probeDevices: async () => [],
      launch: (_command, args, options) => {
        launches.push([...args]);
        const port = args[args.indexOf('--port') + 1];
        const key = args[args.indexOf('--api-key') + 1];
        return spawn(
          process.execPath,
          ['--input-type=module', '-e', childScript, port, key],
          options,
        );
      },
    });
    providers.push(provider);
    await provider.prepare(new AbortController().signal);
    expect(launches[0]).toContain('--threads');
    expect(
      launches[0].slice(launches[0].indexOf('--threads'), launches[0].indexOf('--threads') + 2),
    ).toEqual(['--threads', '7']);
    expect(
      launches[0].slice(launches[0].indexOf('--ctx-size'), launches[0].indexOf('--ctx-size') + 2),
    ).toEqual(['--ctx-size', '42000']);
    expect(
      launches[0].slice(
        launches[0].indexOf('--image-max-tokens'),
        launches[0].indexOf('--image-max-tokens') + 2,
      ),
    ).toEqual(['--image-max-tokens', '512']);
    expect(
      launches[0].slice(
        launches[0].indexOf('--n-gpu-layers'),
        launches[0].indexOf('--n-gpu-layers') + 2,
      ),
    ).toEqual(['--n-gpu-layers', '0']);
    expect(launches[0]).not.toContain('--device');
    expect(provider.snapshot().resources).toMatchObject({
      backend: 'cpu',
      availableBackends: ['cpu'],
      cpuThreads: 7,
      contextTokens: 42000,
      gpuOffloadLayers: 0,
    });
    expect(provider.snapshot().resources?.diagnostic).toMatch(/CUDA is not available/);
    expect(provider.snapshot().resources?.diagnostic).toMatch(/not a GPU utilization quota/);
    const measurement = await provider.resourceMeasurements();
    // Linux /proc can report the test child, other platforms leave RAM unavailable.
    expect(measurement.vramUsedMiB).toBeNull();
    await provider.stop();
    expect(provider.snapshot().resources).toBeNull();
  });

  it('selects an actually probed GPU device and configures explicit offload', async () => {
    let argsSeen: string[] = [];
    const provider = new NativeInference({
      executable: process.execPath,
      resolveModel: async () => ({ modelPath: '/fixture.gguf', projectorPath: null }),
      resourcePreferences: () => ({
        ...DEFAULT_PREFERENCES,
        computeBackend: 'vulkan',
        vramBudgetMiB: 8192,
        gpuOffloadLayers: 24,
      }),
      probeDevices: async () => [{ name: 'Vulkan0', backend: 'vulkan' }],
      launch: (_command, args, options) => {
        argsSeen = [...args];
        return spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            childScript,
            args[args.indexOf('--port') + 1],
            args[args.indexOf('--api-key') + 1],
          ],
          options,
        );
      },
    });
    providers.push(provider);
    await provider.prepare(new AbortController().signal);
    expect(argsSeen.slice(argsSeen.indexOf('--device'), argsSeen.indexOf('--device') + 2)).toEqual([
      '--device',
      'Vulkan0',
    ]);
    expect(
      argsSeen.slice(argsSeen.indexOf('--n-gpu-layers'), argsSeen.indexOf('--n-gpu-layers') + 2),
    ).toEqual(['--n-gpu-layers', '24']);
    expect(provider.snapshot().resources?.backend).toBe('vulkan');
    await provider.stop();
  });

  it('launches the separately shipped Vulkan worker and retains a CPU fallback', async () => {
    const commands: string[] = [];
    let backend: 'vulkan' | 'cpu' = 'vulkan';
    const provider = new NativeInference({
      executable: '/fixture/cpu/bin/llama-server',
      gpuExecutables: { vulkan: '/fixture/vulkan/bin/llama-server' },
      resolveModel: async () => ({ modelPath: '/fixture.gguf', projectorPath: null }),
      resourcePreferences: () => ({
        ...DEFAULT_PREFERENCES,
        computeBackend: 'vulkan',
        vramBudgetMiB: 4096,
        gpuOffloadLayers: 12,
      }),
      probeDevices: async () =>
        backend === 'vulkan' ? [{ name: 'Vulkan0', backend: 'vulkan' }] : [],
      launch: (command, args, options) => {
        commands.push(command);
        return spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            childScript,
            args[args.indexOf('--port') + 1],
            args[args.indexOf('--api-key') + 1],
          ],
          { ...options, cwd: process.cwd() },
        );
      },
    });
    providers.push(provider);
    await provider.prepare(new AbortController().signal);
    expect(commands).toEqual(['/fixture/vulkan/bin/llama-server']);
    expect(provider.snapshot().resources?.backend).toBe('vulkan');
    await provider.stop();
    backend = 'cpu';
    await provider.prepare(new AbortController().signal);
    expect(commands).toEqual(['/fixture/vulkan/bin/llama-server', '/fixture/cpu/bin/llama-server']);
    expect(provider.snapshot().resources?.backend).toBe('cpu');
  });

  it('falls back to CPU after a detected GPU worker crashes during launch', async () => {
    const commands: string[] = [];
    const gpu = '/test/runtime/cuda/llama-server';
    const cpu = '/test/runtime/cpu/llama-server';
    const provider = new NativeInference({
      executable: cpu,
      gpuExecutables: { cuda: gpu },
      resolveModel: async () => ({ modelPath: '/fixture.gguf', projectorPath: null }),
      resourcePreferences: () => ({
        ...DEFAULT_PREFERENCES,
        computeBackend: 'cuda',
        vramBudgetMiB: 4096,
        gpuOffloadLayers: 12,
      }),
      probeDevices: async () => [{ name: 'CUDA0', backend: 'cuda' }],
      launch: (command, args, options) => {
        commands.push(command);
        return spawn(
          process.execPath,
          command === gpu
            ? ['-e', 'process.exit(3)']
            : [
                '--input-type=module',
                '-e',
                childScript,
                args[args.indexOf('--port') + 1],
                args[args.indexOf('--api-key') + 1],
              ],
          { ...options, cwd: process.cwd() },
        );
      },
    });
    providers.push(provider);
    await expect(provider.prepare(new AbortController().signal)).rejects.toThrow(
      /llama.cpp exited/,
    );
    expect(provider.snapshot().phase).toBe('failed');
    await provider.stop(); // Same cleanup path used by the session retry loop.
    await provider.prepare(new AbortController().signal);
    expect(commands).toEqual([gpu, cpu]);
    expect(provider.snapshot().resources).toMatchObject({
      backend: 'cpu',
      gpuOffloadLayers: 0,
    });
    expect(provider.snapshot().resources?.diagnostic).toMatch(/CPU fallback/);
  });

  it('rejects a projector that the loaded runtime does not report as vision capable', async () => {
    const provider = new NativeInference({
      executable: process.execPath,
      resolveModel: async () => ({ modelPath: '/model.gguf', projectorPath: '/wrong-mmproj.gguf' }),
      probeDevices: async () => [],
      launch: (_binary, args, options) =>
        spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            childScript.replace('vision:true', 'vision:false'),
            args[args.indexOf('--port') + 1],
            args[args.indexOf('--api-key') + 1],
          ],
          options,
        ),
    });
    providers.push(provider);
    await expect(provider.prepare(new AbortController().signal)).rejects.toThrow(
      /compatibility.*vision-capable/,
    );
    expect(provider.snapshot().phase).not.toBe('ready');
  });

  it('enables reasoning only when explicitly configured', async () => {
    let launchedArgs: string[] = [];
    const provider = new NativeInference({
      executable: process.execPath,
      reasoningEnabled: () => true,
      resolveModel: async () => ({ modelPath: '/installed/weights.gguf', projectorPath: null }),
      launch: (_binary, args, options) => {
        launchedArgs = [...args];
        const port = args[args.indexOf('--port') + 1];
        const key = args[args.indexOf('--api-key') + 1];
        return spawn(
          process.execPath,
          ['--input-type=module', '-e', childScript, port, key],
          options,
        );
      },
    });
    providers.push(provider);
    await provider.prepare(new AbortController().signal);
    expect(
      launchedArgs.slice(
        launchedArgs.indexOf('--reasoning'),
        launchedArgs.indexOf('--reasoning') + 2,
      ),
    ).toEqual(['--reasoning', 'on']);
  });

  it('applies the latest configured timeout per request and identifies request timeouts', async () => {
    let timeoutMs = 25;
    const provider = new NativeInference({
      executable: process.execPath,
      inferenceTimeoutMs: () => timeoutMs,
      resolveModel: async () => ({ modelPath: '/installed/weights.gguf', projectorPath: null }),
      launch: (_binary, args, options) => {
        const port = args[args.indexOf('--port') + 1];
        const key = args[args.indexOf('--api-key') + 1];
        return spawn(
          process.execPath,
          ['--input-type=module', '-e', childScript, port, key],
          options,
        );
      },
      fetcher: async (url, options) => {
        if (String(url).endsWith('/health')) return fetch(url, options);
        const signal = options?.signal;
        if (!signal) throw new Error('Expected request abort signal');
        return new Promise<never>((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    });
    providers.push(provider);
    await expect(
      provider.generate({ context: 'campfire', cycle: 1 }, new AbortController().signal),
    ).rejects.toThrow('timed out after 0.025 seconds');
    timeoutMs = 50;
    await expect(
      provider.generate({ context: 'campfire', cycle: 2 }, new AbortController().signal),
    ).rejects.toThrow('timed out after 0.05 seconds');
  });

  it('fails clearly on missing binary and permits stop while loading', async () => {
    const provider = new NativeInference({
      executable: '/nonexistent/llama-server',
      resolveModel: async () => ({ modelPath: '/model.gguf', projectorPath: null }),
    });
    providers.push(provider);
    await expect(provider.prepare(new AbortController().signal)).rejects.toThrow(
      /Unable to launch bundled llama.cpp/,
    );
    expect(provider.snapshot().phase).toBe('failed');
    expect(provider.snapshot().error).toMatch(/Unable to launch/);
    await provider.stop();
    expect(provider.snapshot().phase).toBe('stopped');
  });

  it.runIf(Boolean(process.env.LONELY_CHAT_CPU_SMOKE_MODEL))(
    'runs the exact application launcher against a real staged llama-server and GGUF when provided',
    async () => {
      const modelPath = process.env.LONELY_CHAT_CPU_SMOKE_MODEL!;
      const provider = new NativeInference({
        executable: bundledLlamaServer(process.cwd(), false, '', process.platform, process.arch),
        resolveModel: async () => ({
          modelPath,
          projectorPath: process.env.LONELY_CHAT_CPU_SMOKE_PROJECTOR ?? null,
        }),
      });
      providers.push(provider);
      await provider.prepare(new AbortController().signal);
      const output = await provider.generate(
        { context: "I'm playing Sonic", cycle: 1 },
        new AbortController().signal,
      );
      expect(parseInferenceResult(output, Date.now()).messages.length).toBeGreaterThan(0);
      await provider.stop();
    },
    660000,
  );

  it('uses out-of-ASAR platform-specific runtime paths', () => {
    expect(bundledLlamaServer('/app', false, '/resources', 'linux', 'x64')).toBe(
      path.join('/app', 'native', 'llama', 'linux-x64', 'bin', 'llama-server'),
    );
    expect(bundledLlamaServer('/app', true, '/resources', 'win32', 'x64')).toBe(
      path.join('/resources', 'llama', 'win32-x64', 'bin', 'llama-server.exe'),
    );
    expect(
      bundledAcceleratedLlamaServer('/app', true, '/resources', 'vulkan', 'linux', 'x64'),
    ).toBe(path.join('/resources', 'llama', 'linux-x64', 'vulkan', 'bin', 'llama-server'));
    expect(bundledAcceleratedLlamaServer('/app', true, '/resources', 'cuda', 'win32', 'x64')).toBe(
      path.join('/resources', 'llama', 'win32-x64', 'cuda', 'bin', 'llama-server.exe'),
    );
  });
});
