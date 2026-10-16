import { spawn } from 'node:child_process';
import process from 'node:process';

const child = spawn('pnpm', ['exec', 'electron', '.'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  shell: process.platform === 'win32',
  env: { ...process.env, LONELY_CHAT_SMOKE: '1' },
});
let succeeded = false;
for (const stream of [child.stdout, child.stderr]) {
  stream.on('data', (chunk) => {
    const line = chunk.toString();
    process.stdout.write(line);
    if (line.includes('PASS: Electron preload IPC')) succeeded = true;
  });
}
const timeout = setTimeout(() => child.kill(), 20000);
const result = await new Promise((resolve) => child.on('exit', resolve));
clearTimeout(timeout);
if (result !== 0 || !succeeded) {
  throw new Error(`Electron smoke failed: exit ${result} and pass reported ${succeeded}`);
}
