import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { unpackedPackage } from './package-layout.mjs';
import { createCertificationMedia } from './certification-media.mjs';

/** Certify an isolated packaged executable. An optional executable path selects the
 * actual distributed AppImage or a binary installed/copied from NSIS/DMG instead of --dir.
 */
const target = process.platform + '-' + process.arch;
const root = await mkdtemp(path.join(tmpdir(), 'lonely-e2e-'));
const profile = path.join(root, 'profile');
const media = path.join(root, 'media');
const lines = [];
const statuses = [];
const unsupportedHardware = [];
const report = {
  target,
  kind: 'packaged-end-to-end',
  status: 'failed',
  workerMode: 'small deterministic CPU fixtures',
  modelDownloadsRequired: false,
  hardware: process.platform + '-' + process.arch,
  source: process.argv[2] ? 'distributed-artifact' : 'unpacked',
  details: [],
};
try {
  await mkdir(profile, { recursive: true });
  await createCertificationMedia(media);
  const { executable: unpacked } = unpackedPackage();
  const executable = process.argv[2] ? path.resolve(process.argv[2]) : unpacked;
  const listener = createServer();
  await new Promise((resolve, reject) =>
    listener.once('error', reject).listen(0, '127.0.0.1', resolve),
  );
  const overlayPort = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(
    executable,
    process.platform === 'linux'
      ? ['--no-sandbox', '--autoplay-policy=no-user-gesture-required']
      : ['--autoplay-policy=no-user-gesture-required'],
    {
      cwd: root,
      env: {
        ...process.env,
        ...(process.platform === 'linux' && executable.endsWith('.AppImage')
          ? { APPIMAGE_EXTRACT_AND_RUN: '1' }
          : {}),
        LONELY_CHAT_CERTIFY_E2E: '1',
        LONELY_CHAT_CERT_PROFILE: profile,
        LONELY_CHAT_CERT_MEDIA_DIR: media,
        // Avoid a fixed port colliding with other package runners.
        LONELY_CHAT_OVERLAY_PORT: String(overlayPort),
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (data) => {
      const chunk = data.toString('utf8');
      process.stdout.write(chunk);
      output = (output + chunk).slice(-12_000);
      for (const line of chunk.split('\n').filter(Boolean)) {
        if (line.includes('PASS:')) lines.push(line.slice(0, 500));
        if (line.includes('UNSUPPORTED_CODEC:')) statuses.push(line.slice(0, 500));
        if (line.includes('UNSUPPORTED_HARDWARE:')) unsupportedHardware.push(line.slice(0, 500));
      }
    });
  }
  const timeout = setTimeout(() => child.kill(), 90_000);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve(code));
  });
  clearTimeout(timeout);
  if (result !== 0 || !output.includes('PASS: packaged end-to-end Playground'))
    throw new Error('Packaged E2E failed (exit ' + result + '): ' + output.slice(-2500));
  report.status = 'passed';
  report.details = lines;
  console.info('PASS: ' + target + ' complete packaged end-to-end certification');
} catch (error) {
  report.status = unsupportedHardware.length
    ? 'unsupported-hardware'
    : statuses.length
      ? 'unsupported-codec'
      : 'failed';
  report.details = [...unsupportedHardware, ...statuses, String(error).slice(0, 3000)];
  throw error;
} finally {
  const destination = path.join(
    path.resolve('out'),
    'certification-' + (process.argv[2] ? 'distributed-' : '') + target + '.json',
  );
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2) + '\n');
  // All traces, recordings, paths and locally generated media are private and temporary.
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
