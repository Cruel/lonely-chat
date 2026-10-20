import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';

const onWindows = process.platform === 'win32';
const onWSL =
  process.platform === 'linux' &&
  (Boolean(process.env.WSL_DISTRO_NAME) ||
    (() => {
      try {
        return /microsoft|wsl/i.test(readFileSync('/proc/sys/kernel/osrelease', 'utf8'));
      } catch {
        return false;
      }
    })());
// In headless WSL, Chromium cannot infer the Linux Secret Service backend.
// Require an initialized keyring before forcing libsecret: without a default
// collection, Electron can hang waiting for a graphical unlock prompt.
const keyringDirectory = path.join(
  process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share'),
  'keyrings',
);
let keyringInitialized = false;
try {
  keyringInitialized = readdirSync(keyringDirectory).some((name) => name.endsWith('.keyring'));
} catch {
  // GNOME Keyring hasn't been initialized yet.
}
const electronOptions = onWSL && keyringInitialized ? ['--password-store=gnome-libsecret'] : [];
if (onWSL && !keyringInitialized)
  console.warn(
    'WSL: GNOME Keyring not initialized; local private-file credential storage will be used.',
  );

function build(args) {
  execFileSync('pnpm', args, { stdio: 'inherit', shell: onWindows });
}

function ownedPnpm(args, env = process.env) {
  return spawn('pnpm', args, {
    env,
    stdio: 'inherit',
    shell: onWindows,
    detached: !onWindows,
  });
}

function terminate(child) {
  if (!child || child.exitCode !== null) return;
  if (onWindows) {
    // A pnpm.cmd shell otherwise leaves its Electron/Vite child alive.
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      /* already exited */
    }
  }
}

function freeLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Could not allocate a development port'));
        server.close();
        return;
      }
      const { port } = address;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

build(['build:electron']);
build(['build:renderer']);
const port = await freeLoopbackPort();
const devOrigin = `http://127.0.0.1:${port}`;
const ui = ownedPnpm(
  ['exec', 'vp', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  { ...process.env, LONELY_CHAT_RENDERER_PORT: String(port) },
);
let desktop = null;
let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  terminate(desktop);
  terminate(ui);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
ui.once('exit', (code) => {
  if (!stopping) process.exitCode = code || 1;
  stop();
});
try {
  let ready = false;
  for (let attempts = 0; attempts < 100 && !stopping; attempts++) {
    try {
      const response = await fetch(devOrigin);
      if (response.ok && (await response.text()).includes('<title>Lonely Chat</title>')) {
        ready = true;
        break;
      }
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!ready && !stopping) throw new Error('Vite development renderer failed to start');
  if (!stopping) {
    desktop = ownedPnpm(['exec', 'electron', '.', ...electronOptions], {
      ...process.env,
      LONELY_CHAT_RENDERER_URL: devOrigin,
    });
    const [code] = await once(desktop, 'exit');
    if (code !== 0 && !stopping) process.exitCode = 1;
  }
} finally {
  stop();
}
