// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ChatView } from './chat-view';

afterEach(cleanup);
it('renders author and presentation text in the accessible chat log', () => {
  Element.prototype.scrollIntoView = () => {};
  render(
    <ChatView
      messages={[
        {
          id: '1',
          author: 'pixelpilot',
          text: 'hello from preview',
          color: '#bba5ff',
          presentedAt: 12,
        },
      ]}
    />,
  );
  expect(screen.getByRole('log', { name: /simulated viewer chat/i }).textContent).toContain(
    'hello from preview',
  );
  expect(screen.getByText('pixelpilot')).toBeTruthy();
});
