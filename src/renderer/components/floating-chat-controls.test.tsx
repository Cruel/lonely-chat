// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FloatingChatControls } from './floating-chat-controls';
import type { DesktopAPI } from '../../shared/chat-contract';
import {
  DEFAULT_FLOATING_CHAT_SETTINGS,
  type FloatingChatSnapshot,
} from '../../shared/floating-chat-contract';

afterEach(() => {
  cleanup();
  delete window.lonelyChat;
});

it('opens and closes the managed window, updates flags and dimensions, reacts to external close', async () => {
  let current: FloatingChatSnapshot = {
    open: false,
    settings: { ...DEFAULT_FLOATING_CHAT_SETTINGS },
    warning: null,
  };
  let subscriber: ((next: FloatingChatSnapshot) => void) | undefined;
  const notify = () => subscriber?.(current);
  const openFloatingChat = vi.fn(async () => {
    current = { ...current, open: true };
    notify();
    return current;
  });
  const closeFloatingChat = vi.fn(async () => {
    current = { ...current, open: false };
    notify();
    return current;
  });
  const configureFloatingChat = vi.fn(async (settings: typeof current.settings) => {
    current = { ...current, settings };
    notify();
    return current;
  });
  window.lonelyChat = {
    getFloatingChat: async () => current,
    onFloatingChatChange: (listener: typeof subscriber) => {
      subscriber = listener;
      return () => {
        subscriber = undefined;
      };
    },
    openFloatingChat,
    closeFloatingChat,
    configureFloatingChat,
  } as unknown as DesktopAPI;

  render(<FloatingChatControls />);
  const open = await screen.findByRole('button', { name: 'Open floating window' });
  fireEvent.click(open);
  await waitFor(() => expect(openFloatingChat).toHaveBeenCalledOnce());
  fireEvent.click(await screen.findByRole('button', { name: 'Close floating window' }));
  await waitFor(() => expect(closeFloatingChat).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByLabelText('Width (px)'), { target: { value: '510' } });
  fireEvent.change(screen.getByLabelText('Height (px)'), { target: { value: '480' } });
  fireEvent.click(screen.getByRole('button', { name: 'Apply size' }));
  await waitFor(() =>
    expect(configureFloatingChat).toHaveBeenCalledWith({
      ...DEFAULT_FLOATING_CHAT_SETTINGS,
      width: 510,
      height: 480,
    }),
  );
  fireEvent.click(screen.getByLabelText('Transparent background'));
  await waitFor(() =>
    expect(configureFloatingChat).toHaveBeenCalledWith({
      ...DEFAULT_FLOATING_CHAT_SETTINGS,
      width: 510,
      height: 480,
      transparent: true,
    }),
  );
  current = { ...current, open: false, warning: 'Feature unavailable on this window manager' };
  notify();
  expect(await screen.findByRole('status')).toHaveProperty('textContent', current.warning);
  expect(screen.getByRole('button', { name: 'Open floating window' })).toBeTruthy();
});

it('rejects invalid sizes in UI and reports errors from Electron', async () => {
  window.lonelyChat = {
    getFloatingChat: async () => ({
      open: false,
      settings: DEFAULT_FLOATING_CHAT_SETTINGS,
      warning: null,
    }),
    onFloatingChatChange: () => () => {},
    openFloatingChat: async () => {
      throw new Error('Display unavailable');
    },
  } as unknown as DesktopAPI;
  render(<FloatingChatControls />);
  const open = await screen.findByRole('button', { name: 'Open floating window' });
  await waitFor(() => expect(open.hasAttribute('disabled')).toBe(false));
  fireEvent.change(screen.getByLabelText('Width (px)'), { target: { value: '30' } });
  expect(screen.getByRole('button', { name: 'Apply size' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(open);
  expect((await screen.findByRole('alert')).textContent).toContain('Display unavailable');
});
