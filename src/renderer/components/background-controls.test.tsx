// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BackgroundControls } from './background-controls';
import type { DesktopAPI } from '../../shared/chat-contract';

afterEach(() => {
  cleanup();
  delete window.lonelyChat;
});

it('reads and updates persistent close-to-tray preference', async () => {
  const setCloseToTray = vi.fn(async (enabled: boolean) => ({
    closeToTray: enabled,
    trayAvailable: enabled,
  }));
  window.lonelyChat = {
    getWindowStatus: async () => ({ closeToTray: true, trayAvailable: true }),
    setCloseToTray,
  } as unknown as DesktopAPI;
  render(<BackgroundControls />);
  const setting = await screen.findByRole('checkbox', {
    name: 'Close to system tray during simulation',
  });
  await waitFor(() => expect((setting as HTMLInputElement).checked).toBe(true));
  fireEvent.click(setting);
  await waitFor(() => expect(setCloseToTray).toHaveBeenCalledWith(false));
  expect((setting as HTMLInputElement).checked).toBe(false);
});

it('shows unavailable tray and failed persistence without losing current setting', async () => {
  window.lonelyChat = {
    getWindowStatus: async () => ({ closeToTray: true, trayAvailable: false }),
    setCloseToTray: async () => {
      throw new Error('settings are read-only');
    },
  } as unknown as DesktopAPI;
  render(<BackgroundControls />);
  expect((await screen.findByRole('status')).textContent).toContain(
    'does not provide a usable system tray',
  );
  fireEvent.click(screen.getByRole('checkbox', { name: 'Close to system tray during simulation' }));
  expect((await screen.findByRole('alert')).textContent).toContain('settings are read-only');
});
