import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { NativeInference, extractNativeChat, nativeChatRequest } from './native-inference';
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
      }),
    ).toThrow(/incomplete/);
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
    const result = await provider.generate(
      { context: 'campfire', cycle: 1 },
      new AbortController().signal,
    );
    expect(parseInferenceResult(result, 1000).messages[0].text).toBe('warm fire');
    expect(launchedArgs).toContain('--no-webui');
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
    await provider.stop();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
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
    await provider.stop();
  });

  it.runIf(Boolean(process.env.LONELY_CHAT_CPU_SMOKE_MODEL))(
    'runs the exact application launcher against a real staged llama-server and GGUF when provided',
    async () => {
      const modelPath = process.env.LONELY_CHAT_CPU_SMOKE_MODEL!;
      const provider = new NativeInference({
        executable: bundledLlamaServer(process.cwd(), false, '', process.platform, process.arch),
        resolveModel: async () => ({ modelPath, projectorPath: null }),
      });
      providers.push(provider);
      await provider.prepare(new AbortController().signal);
      const output = await provider.generate(
        { context: 'Playing chess.', cycle: 1 },
        new AbortController().signal,
      );
      expect(parseInferenceResult(output, Date.now()).messages.length).toBeGreaterThan(0);
      await provider.stop();
    },
    120000,
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
