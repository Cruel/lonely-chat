import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const fixture = spawn(process.execPath, ['dist-electron/tools/overlay-fixture.mjs'], {
  stdio: ['pipe', 'pipe', 'inherit'],
});
const lines = createInterface({ input: fixture.stdout });
const iterator = lines[Symbol.asyncIterator]();
const next = async () => {
  const result = await iterator.next();
  if (result.done) throw new Error('Fixture exited unexpectedly');
  return JSON.parse(result.value);
};
let browser;
try {
  const { type, url } = await next();
  assert.equal(type, 'ready');
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url);
  await page.getByRole('log').getByText('pixelpilot').waitFor();
  assert.equal(await page.evaluate(() => typeof window.lonelyChat), 'undefined');
  assert.equal(
    await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    'rgba(0, 0, 0, 0)',
  );
  assert.equal((await page.request.get(new URL('/api/config', url).href)).status(), 404);
  fixture.stdin.write('publish\n');
  assert.equal((await next()).sequence, 2);
  await page.getByRole('log').getByText('lunar_fox').waitFor();
  await page.reload();
  await page.getByRole('log').getByText('lunar_fox').waitFor();
  assert.equal(await page.getByRole('log').locator('.chat-enter').count(), 2);
  assert.deepEqual(errors, []);
  console.log(
    'PASS: headless overlay snapshot, ordered updates, reload/reconnect and read-only isolation',
  );
} finally {
  await browser?.close();
  fixture.stdin.write('quit\n');
  fixture.stdin.end();
}
