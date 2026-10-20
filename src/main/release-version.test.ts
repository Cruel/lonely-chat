import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function verify(tag?: string) {
  return spawnSync(
    process.execPath,
    ['scripts/verify-release-version.mjs', ...(tag ? [tag] : [])],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
}

describe('release identity is gated on package.json version', () => {
  it('accepts the authoritative version and its exact release tag', () => {
    expect(verify().status).toBe(0);
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
    expect(verify(`v${version}`).status).toBe(0);
  });

  it('rejects mismatched tags before publishing any release artifacts', () => {
    const mismatch = verify('v9.9.9');
    expect(mismatch.status).not.toBe(0);
    expect(mismatch.stderr).toMatch(/Release tag must exactly match package.json version/);
  });

  it('requires the v prefix on a matching version tag', () => {
    const version = JSON.parse(readFileSync('package.json', 'utf8')).version as string;
    const missingPrefix = verify(version);
    expect(missingPrefix.status).not.toBe(0);
    expect(missingPrefix.stderr).toMatch(/Release tag must exactly match package.json version/);
  });
});
