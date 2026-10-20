// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DesktopAPI } from '../../shared/chat-contract';
import { RemoteConnectionsPanel } from './remote-connections-panel';

afterEach(() => {
  cleanup();
  delete window.lonelyChat;
});

it('shows a reusable clickable sign-in URL and copy button during authorization, then removes them', async () => {
  const authorizationUrl =
    'https://auth.openai.com/api/accounts/authorize?state=private-test-state';
  let notify: ((url: string | null) => void) | undefined;
  const open = vi.fn(async () => {});
  const copy = vi.fn(async () => {});
  const signIn = vi.fn(() => new Promise<never>(() => {}));
  window.lonelyChat = {
    getChatGPTStatus: async () => ({ activeAccountId: null, accounts: [] }),
    listRemoteConfigurations: async () => ({ connections: [], models: [] }),
    getChatGPTAuthorizationUrl: async () => null,
    onChatGPTAuthorizationChange: (listener: (url: string | null) => void) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
    signInChatGPT: signIn,
    openChatGPTAuthorizationUrl: open,
    copyChatGPTAuthorizationUrl: copy,
  } as unknown as DesktopAPI;

  render(<RemoteConnectionsPanel />);
  expect(screen.queryByRole('link', { name: 'Open sign-in link' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Continue with ChatGPT' }));
  await waitFor(() => expect(signIn).toHaveBeenCalledTimes(1));
  await act(async () => {
    notify?.(authorizationUrl);
  });

  const link = screen.getByRole('link', { name: 'Open sign-in link' }) as HTMLAnchorElement;
  expect(link.href).toBe(authorizationUrl);
  fireEvent.click(link);
  await waitFor(() => expect(open).toHaveBeenCalledTimes(1));

  fireEvent.click(screen.getByRole('button', { name: 'Copy ChatGPT sign-in link' }));
  await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('Sign-in link copied to clipboard.')).toBeTruthy();

  await act(async () => {
    notify?.(null);
  });
  expect(screen.queryByRole('link', { name: 'Open sign-in link' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Copy ChatGPT sign-in link' })).toBeNull();
});

it('recovers the pending authorization URL on remount and keeps failed manual opens actionable', async () => {
  const url = 'https://auth.openai.com/api/accounts/authorize?state=pending';
  const open = vi.fn().mockRejectedValue(new Error('xdg-open failed'));
  const copy = vi.fn(async () => {});
  window.lonelyChat = {
    getChatGPTStatus: async () => ({ activeAccountId: null, accounts: [] }),
    listRemoteConfigurations: async () => ({ connections: [], models: [] }),
    getChatGPTAuthorizationUrl: async () => url,
    onChatGPTAuthorizationChange: () => () => {},
    openChatGPTAuthorizationUrl: open,
    copyChatGPTAuthorizationUrl: copy,
  } as unknown as DesktopAPI;

  render(<RemoteConnectionsPanel />);
  const link = await screen.findByRole('link', { name: 'Open sign-in link' });
  fireEvent.click(link);
  expect(
    await screen.findByText('Unable to open the browser. Copy the sign-in link instead.'),
  ).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Open sign-in link' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Copy ChatGPT sign-in link' }));
  await waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
});
