import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { router } from './router';
import './index.css';
import { installRendererErrorReporting, reportRendererFailure } from './renderer-error-reporting';

const root = document.getElementById('root');
if (!root) throw new Error('Missing root element');
installRendererErrorReporting();
createRoot(root, {
  onUncaughtError: (error) => reportRendererFailure('react', 'react', error),
  onCaughtError: (error) => reportRendererFailure('react', 'react', error),
  onRecoverableError: (error) => reportRendererFailure('react', 'react', error),
}).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
