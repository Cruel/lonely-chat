import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const target = `${process.platform}-${process.arch}`;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const executable = path.join(
  root,
  'native',
  'whisper',
  target,
  'bin',
  process.platform === 'win32' ? 'lonely-whisper-worker.exe' : 'lonely-whisper-worker',
);
await access(executable);
const marker = await readFile(path.join(root, 'native', 'whisper', target, '.release'), 'utf8');
if (!marker.startsWith('d1be6fde11ac6e0407606b4e42fe72d34add8037:')) {
  throw new Error('Native whisper.cpp worker is not pinned.');
}

const child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const expected = process.env.LONELY_CHAT_CPU_SMOKE_SPEECH_MODEL;
let buffered = Buffer.alloc(0);
let pending = null;
let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr = (stderr + chunk.toString('utf8')).slice(-1000);
});
child.stdout.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const size = buffered.readUInt32LE(0);
    if (size < 1 || size > 16_000 * 4 * 30 + 32) {
      pending?.reject(new Error('Invalid speech IPC response length.'));
      pending = null;
      return;
    }
    if (buffered.length < size + 4) return;
    const reply = {
      kind: buffered[4],
      text: buffered.subarray(5, 4 + size).toString('utf8'),
    };
    buffered = buffered.subarray(size + 4);
    pending?.resolve(reply);
    pending = null;
  }
});
child.on('error', (error) => {
  pending?.reject(error);
  pending = null;
});
child.on('exit', (code) => {
  pending?.reject(new Error(`Speech worker exited (${code}). ${stderr}`));
  pending = null;
});

function send(kind, payload) {
  return new Promise((resolve, reject) => {
    if (pending) {
      reject(new Error('Concurrent smoke IPC request.'));
      return;
    }
    const size = payload.length + 1;
    const message = Buffer.alloc(5 + payload.length);
    message.writeUInt32LE(size, 0);
    message[4] = kind;
    payload.copy(message, 5);
    pending = { resolve, reject };
    child.stdin.write(message, (error) => {
      if (error) {
        pending?.reject(error);
        pending = null;
      }
    });
  });
}

const timeout = setTimeout(() => {
  pending?.reject(new Error('Speech CPU smoke timed out.'));
  pending = null;
  child.kill();
}, 180_000);
try {
  const model = Buffer.from(expected ?? '/nonexistent/whisper-model.bin', 'utf8');
  const init = await send(1, model);
  if (!expected) {
    if (init.kind !== 0xff) {
      throw new Error(`Expected a missing-model IPC error, got ${init.kind}: ${init.text}`);
    }
    console.log('PASS: pinned native whisper.cpp framed IPC and missing-model error');
  } else {
    if (init.kind !== 0x81) {
      throw new Error(`Native speech model failed to load: ${init.text}`);
    }
    // Silence is deterministic, and we only require a valid framed transcription result.
    // Speech recognition quality needs genuine media, not a synthetic CI fixture.
    const pcm = Buffer.alloc(16000 * 4);
    const response = await send(2, pcm);
    if (response.kind !== 0x82) {
      throw new Error(`Native speech PCM inference failed: ${response.text}`);
    }
    console.log('PASS: pinned native whisper.cpp loaded CPU model and transcribed 1s PCM');
  }
} finally {
  clearTimeout(timeout);
  child.kill();
}
