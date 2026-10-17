import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer, type Server } from 'node:net';
import { OverlayPortStore } from './overlay-port-store';
import { OverlayController } from './overlay-controller';

describe('recoverable overlay listener', () => {
  const roots: string[] = [];
  const controllers: OverlayController[] = [];
  const occupied: Server[] = [];

  afterEach(async () => {
    for (const controller of controllers.splice(0)) await controller.stop();
    for (const server of occupied.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  });

  async function setup() {
    const root = await mkdtemp(path.join(tmpdir(), 'lonely-overlay-controller-'));
    roots.push(root);
    const store = new OverlayPortStore(root);
    const controller = new OverlayController(() => {
      const server = createServer();
      return {
        start: (port) =>
          new Promise<string>((resolve, reject) => {
            server.once('error', reject);
            server.listen(port, '127.0.0.1', () => {
              server.off('error', reject);
              resolve(`http://127.0.0.1:${port}/overlay`);
            });
          }),
        stop: () =>
          new Promise<void>((resolve) => {
            if (!server.listening) {
              resolve();
              return;
            }
            server.close(() => resolve());
          }),
      };
    }, store);
    controllers.push(controller);
    return { store, controller };
  }

  async function reserve() {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    occupied.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    return address.port;
  }

  it('keeps desktop state available on EADDRINUSE and recovers by changing ports', async () => {
    const { store, controller } = await setup();
    const port = await reserve();
    await store.write(port);
    const events: string[] = [];
    controller.subscribe((status) => events.push(status.error ?? status.url ?? 'stopped'));
    const failed = await controller.initialize();
    expect(failed.port).toBe(port);
    expect(failed.url).toBeNull();
    expect(failed.error).toContain('already in use or reserved');

    const recoveredPort = await reserve();
    const reserveServer = occupied.pop()!;
    await new Promise<void>((resolve) => reserveServer.close(() => resolve()));
    const recovered = await controller.configure(recoveredPort);
    expect(recovered.url).toBe(`http://127.0.0.1:${recoveredPort}/overlay`);
    expect(recovered.error).toBeNull();
    expect(await store.read()).toBe(recoveredPort);
    expect(events).toHaveLength(2);
  });

  it('preserves a working listener and saved port if a replacement cannot bind', async () => {
    const { controller, store } = await setup();
    const currentPort = await reserve();
    const first = occupied.pop()!;
    await new Promise<void>((resolve) => first.close(() => resolve()));
    expect((await controller.configure(currentPort)).url).toContain(String(currentPort));
    const blockedPort = await reserve();
    const failure = await controller.configure(blockedPort);
    expect(failure.port).toBe(currentPort);
    expect(failure.url).toBe(`http://127.0.0.1:${currentPort}/overlay`);
    expect(failure.error).toContain(String(blockedPort));
    expect(await store.read()).toBe(currentPort);
    const again = await controller.configure(currentPort);
    expect(again.error).toBeNull();
    expect((await controller.snapshot()).url).toContain(String(currentPort));
  });

  it('validates ports and retries after a failed bind', async () => {
    const { controller } = await setup();
    await expect(controller.configure(65536)).rejects.toThrow(/port/);
    await expect(controller.configure(0)).rejects.toThrow(/port/);
    const port = await reserve();
    expect((await controller.configure(port)).url).toBeNull();
    const server = occupied.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect((await controller.configure(port)).url).toContain(String(port));
  });
});
