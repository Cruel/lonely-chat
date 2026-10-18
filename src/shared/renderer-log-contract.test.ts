import { describe, expect, it } from 'vitest';
import { makeRendererFailure, validateRendererFailure } from './renderer-log-contract';

describe('renderer failure privacy boundary', () => {
  it('keeps app code locations and error causes, but never forwards private input', () => {
    const secret = 'PRIVATE_TRANSCRIPT_AND_PASSWORD_523';
    const cause = new TypeError('password=' + secret);
    const failure = new Error('a prompt: ' + secret, { cause });
    failure.stack = `Error: ${secret}\n    at render (http://127.0.0.1:5173/src/renderer/routes/app.tsx:125:9)\n    at privateFunction (${secret}:51:5)\n    at http://127.0.0.1:5173/assets/index-1234.js:88:12`;
    const report = makeRendererFailure('simulation', 'react', failure);
    expect(report).toMatchObject({
      name: 'Error',
      cause: 'TypeError',
      frames: ['src/renderer/routes/app.tsx:125:9', 'assets/index-1234.js:88:12'],
    });
    expect(JSON.stringify(report)).not.toContain(secret);
    expect(validateRendererFailure(report)).toEqual(report);
    failure.stack = `Error: assets/PRIVATE_TOKEN_888.js:1:1\nnot-a-frame assets/PRIVATE_TOKEN_999.js:2:2\n at render (src/renderer/routes/app.tsx:2:3)`;
    expect(makeRendererFailure('react', 'uncaught', failure).frames).toEqual([
      'src/renderer/routes/app.tsx:2:3',
    ]);
  });
  it('rejects injected content and extra fields at the privileged IPC boundary', () => {
    const valid = makeRendererFailure('overlay', 'operation', new TypeError('foo'));
    expect(() => validateRendererFailure({ ...valid, extra: 'secret' })).toThrow();
    expect(() => validateRendererFailure({ ...valid, area: 'private-secret' })).toThrow();
    expect(() =>
      validateRendererFailure({ ...valid, frames: ['private request: SECRET'] }),
    ).toThrow();
    expect(() => validateRendererFailure({ ...valid, cause: { message: 'token' } })).toThrow();
  });
});
