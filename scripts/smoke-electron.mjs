import { spawn } from 'node:child_process';
import process from 'node:process';
import { unpackedPackage } from './package-layout.mjs';

const packaged = process.argv.includes('--packaged');
const child = spawn(
  packaged ? unpackedPackage().executable : 'pnpm',
  packaged ? [] : ['exec', 'electron', '.'],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: !packaged && process.platform === 'win32',
    env: { ...process.env, LONELY_CHAT_SMOKE: '1' },
  },
);
let succeeded = false;
let output = '';
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    const line = chunk.toString();
    process.stdout.write(line);
    output = (output + line).slice(-4096);
    if (output.includes('PASS: Electron preload IPC')) succeeded = true;
  });
}
const timeout = setTimeout(() => child.kill(), 45000);
const result = await new Promise((resolve) => child.on('exit', resolve));
clearTimeout(timeout);
if (result !== 0 || !succeeded) {
  throw new Error(`Electron smoke failed: exit ${result} and pass reported ${succeeded}`);
}
// Explicit Quit must release the owned loopback listener, not only exit the UI.
let listenerStillOpen = false;
try {
  await fetch(`http://127.0.0.1:${process.env.LONELY_CHAT_OVERLAY_PORT ?? 45939}/overlay`, {
    signal: AbortSignal.timeout(1500),
  });
  listenerStillOpen = true;
} catch {
  // Connection refused is expected after the managed overlay has stopped.
}
if (listenerStillOpen) throw new Error('Overlay listener survived Electron Quit');
