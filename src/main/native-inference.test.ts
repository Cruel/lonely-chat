import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { NativeInference, extractNativeChat, nativeChatRequest } from './native-inference';
import { AUTHOR_PLACEHOLDER } from '../shared/audience-contract';
import { parseInferenceResult } from './fake-inference';
import { bundledLlamaServer } from './native-runtime-path';

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
  if (request.url !== '/v1/chat/completions' || request.headers.authorization !== 'Bearer ' + key) {
    response.writeHead(401);
    response.end(JSON.stringify({error:'unauthorized'}));
    return;
  }
  let body='';
  for await (const chunk of request) body += chunk;
  const parsed = JSON.parse(body);
  if (parsed.messages[0].content.startsWith('Generate distinct')) {
    response.end(JSON.stringify({choices:[{finish_reason:'stop', message:{content:JSON.stringify({names:['TestFox','TestCat']})}}]}));
    return;
  }
  if (parsed.response_format?.type !== 'json_object' || parsed.messages[1].content.indexOf('campfire') < 0) {
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

  it('uses dynamic roster grammar and resolves placeholders while preferring names outside recent history', () => {
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
    expect(extractNativeChat(payload, roster, [{ author: 'ChatFox' }])).toMatchObject({
      messages: [{ author: 'ChatCat', color: '#abcdef' }],
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
      await provider.generateRoster(2, ['ExcludedName'], new AbortController().signal),
    ).toEqual(['TestFox', 'TestCat']);
    const result = await provider.generate(
      { context: 'campfire', cycle: 1 },
      new AbortController().signal,
    );
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
      '/app/native/llama/linux-x64/bin/llama-server',
    );
    expect(bundledLlamaServer('/app', true, '/resources', 'win32', 'x64')).toBe(
      '/resources/llama/win32-x64/bin/llama-server.exe',
    );
  });
});
