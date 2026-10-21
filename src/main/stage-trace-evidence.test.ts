import { expect, it } from 'vitest';
import { privateStageMetadata } from './stage-trace-evidence';

it('excludes credentials and image/audio/video bytes but preserves source and submitted metadata', () => {
  const request = {
    authorization: 'Bearer secret',
    headers: { 'api-key': 'secret', cookie: 'private-session' },
    content: [
      {
        type: 'image',
        sourceId: 'camera',
        observedAt: 1700000000100,
        dataUrl: 'data:image/jpeg;base64,c2Vuc2l0aXZl',
      },
      { type: 'audio', data: 'data:audio/wav;base64,c2Vuc2l0aXZl' },
      { type: 'text', text: 'the picture has a window' },
    ],
    nested: { refresh_token: 'sensitive', client_secret: 'hidden' },
  };
  const result = privateStageMetadata(request);
  const json = JSON.stringify(result);
  expect(json).toContain('camera');
  expect(json).toContain('1700000000100');
  expect(json).toContain('the picture has a window');
  expect(json).toContain('mediaOmitted');
  for (const secret of [
    'Bearer secret',
    'private-session',
    'c2Vuc2l0aXZl',
    'sensitive',
    'hidden',
  ]) {
    expect(json).not.toContain(secret);
  }
  expect(request.content[0].dataUrl).toContain('c2Vuc2l0aXZl'); // no mutation
});
