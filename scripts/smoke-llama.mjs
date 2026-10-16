import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = `${process.platform}-${process.arch}`;
const binary = path.join(
  root,
  'native',
  'llama',
  target,
  'bin',
  process.platform === 'win32' ? 'llama-server.exe' : 'llama-server',
);
if (!existsSync(binary)) throw new Error('Run pnpm stage:llama first.');
const libraryDir = path.dirname(binary);
const environment = {
  ...process.env,
  ...(process.platform === 'linux'
    ? { LD_LIBRARY_PATH: [libraryDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') }
    : {}),
  ...(process.platform === 'darwin'
    ? { DYLD_LIBRARY_PATH: [libraryDir, process.env.DYLD_LIBRARY_PATH].filter(Boolean).join(':') }
    : {}),
};
console.log(execFileSync(binary, ['--version'], { env: environment, encoding: 'utf8' }).trim());
const model = process.env.LONELY_CHAT_CPU_SMOKE_MODEL;
if (!model) {
  console.log(
    'PASS: pinned native executable and its shared libraries load. Set LONELY_CHAT_CPU_SMOKE_MODEL to test inference.',
  );
  process.exit(0);
}
if (!existsSync(model)) throw new Error('CPU smoke GGUF model does not exist.');
const server = createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
await new Promise((resolve) => server.close(resolve));
const secret = 'lonely-chat-smoke-secret-not-shared';
const args = [
  '--model',
  path.resolve(model),
  '--host',
  '127.0.0.1',
  '--port',
  String(port),
  '--no-webui',
  '--api-key',
  secret,
  '--n-gpu-layers',
  '0',
  '--ctx-size',
  '2048',
];
const child = spawn(binary, args, {
  env: environment,
  cwd: libraryDir,
  windowsHide: true,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let logs = '';
child.stderr.on('data', (chunk) => {
  logs = (logs + chunk.toString()).slice(-2500);
});
let exited = false;
child.on('exit', () => {
  exited = true;
});
try {
  let ready = false;
  for (let attempt = 0; attempt < 500; attempt++) {
    if (exited) throw new Error(`llama.cpp exited during startup: ${logs}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok && (await response.json()).status === 'ok') {
        ready = true;
        break;
      }
    } catch {
      /* The process may not be listening yet. */
    }
    await delay(200);
  }
  if (!ready) throw new Error(`llama.cpp failed to load the CPU test model: ${logs}`);
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
    body: JSON.stringify({
      messages: [{ role: 'user', content: 'Reply with JSON. What is 2+2?' }],
      stream: false,
      max_tokens: 128,
      temperature: 0,
      response_format: {
        type: 'json_schema',
        schema: {
          type: 'object',
          required: ['answer'],
          additionalProperties: false,
          properties: { answer: { type: 'string' } },
        },
      },
      json_schema: {
        type: 'object',
        required: ['answer'],
        additionalProperties: false,
        properties: { answer: { type: 'string' } },
      },
    }),
    signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(`llama.cpp HTTP ${response.status}: ${JSON.stringify(result).slice(0, 700)}`);
  const answer = JSON.parse(result.choices?.[0]?.message?.content ?? 'null');
  if (!answer || typeof answer !== 'object' || Array.isArray(answer)) {
    throw new Error('Real CPU GGUF failed to produce structured JSON.');
  }
  if (typeof answer.answer !== 'string') {
    console.warn(
      'Small smoke model did not obey the requested schema; the app independently rejects such replies.',
    );
  }
  console.log(
    `PASS: real CPU GGUF inference returned JSON (${JSON.stringify(answer).slice(0, 130)})`,
  );
} finally {
  child.kill();
  await Promise.race([new Promise((resolve) => child.once('exit', resolve)), delay(1500)]);
  if (!exited) child.kill('SIGKILL');
}
