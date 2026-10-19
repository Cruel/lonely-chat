import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

// 48x32 VP8/WebM, 4 seconds at 4 fps. Tiny, deterministic, royalty-free synthetic
// black frames encoded with FFmpeg 7.1; decoded by the packaged Chromium runtime.
// No FFmpeg executable, camera, network, or codec installer is required during CI.
const VIDEO_BASE64 =
  'GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAONEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHWTbuMU6uEElTDZ1OsggEjTbuMU6uEHFO7a1OsggN37AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsCrXsYMPQkBNgIxMYXZmNjEuNy4xMDNXQYxMYXZmNjEuNy4xMDNEiYhAr0AAAAAAABZUrmvIrgEAAAAAAAA/14EBc8WIWzs6hvNYdNmcgQAitZyDdW5kiIEAhoVWX1ZQOIOBASPjg4QO5rKA4JCwgTC6gSCagQJVsIRVuYEBElTDZ/tzc59jwIBnyJlFo4dFTkNPREVSRIeMTGF2ZjYxLjcuMTAzc3PWY8CLY8WIWzs6hvNYdNlnyKFFo4dFTkNPREVSRIeUTGF2YzYxLjE5LjEwMSBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjA0LjAwMDAwMDAwMAAfQ7Z1Qc7ngQCjpYEAAIBQAgCdASowACAAAEcIhYWImYSIAgIABwygaZwA/v+rUICjmoEA+gDRAQABEBAAGAAcR/QMAAbUYP7/q1CAo5qBAfQA0QEAARAQABgAHEf0DAAG1GD+/6tQgKOagQLuANEBAAEQEAAYABxH9AwABtRg/v+rUICjmoED6ADRAQABEBAAGAAcR/QMAAbUYP7/q1CAo5qBBOIA0QEAARAQABgAHEf0DAAG1GD+/6tQgKOagQXcANEBAAEQEAAYABxH9AwABtRg/v+rUICjmoEG1gDRAQABEBAUYABxH9AwABtRgP7/q1CAo5qBB9AA0QEAARAQABgAHEf0DAAG1GD+/6tQgKOagQjKANEBAAEQEAAYABxH9AwABtRg/v+rUICjmoEJxADRAQABEBAAGAAcR/QMAAbUYP7/q1CAo5qBCr4A0QEAARAQABgAHEf0DAAG1GD+/6tQgKOagQu4ANEBAAEQEAAYABxH9AwABtRg/v+rUICjmoEMsgDRAQABEBAAGAAcR/QMAAbUYP7/q1CAo5qBDawA0QEAARAQFGAAcR/QMAAbUYD+/6tQgKOagQ6mANEBAAEQEAAYABxH9AwABtRg/v+rUIAcU7trkbuPs4EAt4r3gQHxggGj8IED';

function toneWav(startSeconds, stopSeconds, frequency) {
  const rate = 16000;
  const frames = rate * 4;
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24);
  bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(frames * 2, 40);
  for (let i = 0; i < frames; i++) {
    const t = i / rate;
    const amplitude = t >= startSeconds && t < stopSeconds ? 0.4 : 0;
    bytes.writeInt16LE(
      Math.round(Math.sin(2 * Math.PI * frequency * t) * amplitude * 32767),
      44 + 2 * i,
    );
  }
  return bytes;
}

export async function createCertificationMedia(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const video = path.join(directory, 'scene.webm');
  const mic = path.join(directory, 'microphone.wav');
  const game = path.join(directory, 'gameplay.wav');
  await Promise.all([
    writeFile(video, Buffer.from(VIDEO_BASE64, 'base64')),
    writeFile(mic, toneWav(0.25, 1.35, 440)),
    writeFile(game, toneWav(1.15, 2.4, 650)),
  ]);
  return { video, mic, game };
}
