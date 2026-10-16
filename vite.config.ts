import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';
import { defineConfig } from 'vite-plus';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const root = path.dirname(fileURLToPath(import.meta.url));
const devPort = Number(process.env.LONELY_CHAT_RENDERER_PORT ?? 5173);
const externals = [...builtinModules, ...builtinModules.map((id) => `node:${id}`), 'electron'];

export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(root, 'src/renderer') } },
  server: { host: '127.0.0.1', port: devPort, strictPort: true, hmr: { clientPort: devPort } },
  build: { outDir: 'dist-electron/renderer', emptyOutDir: true },
  fmt: {
    printWidth: 100,
    semi: true,
    singleQuote: true,
    trailingComma: 'all',
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
  pack: [
    {
      name: 'main',
      entry: { main: 'src/main/index.ts' },
      platform: 'node',
      target: 'node24',
      format: 'cjs',
      outDir: 'dist-electron/main',
      fixedExtension: true,
      clean: true,
      deps: { neverBundle: externals, alwaysBundle: ['ws'] },
      outputOptions: { codeSplitting: false },
    },
    {
      name: 'overlay-test-fixture',
      entry: { 'overlay-fixture': 'src/main/overlay-fixture.ts' },
      platform: 'node',
      target: 'node24',
      format: 'esm',
      outDir: 'dist-electron/tools',
      fixedExtension: true,
      clean: true,
      deps: { neverBundle: externals, alwaysBundle: ['ws'] },
      outputOptions: { codeSplitting: false },
    },
    {
      name: 'preload',
      entry: { preload: 'src/preload/index.ts' },
      platform: 'node',
      target: 'node24',
      format: 'cjs',
      outDir: 'dist-electron/preload',
      fixedExtension: true,
      clean: true,
      deps: { neverBundle: externals },
      outputOptions: { codeSplitting: false },
    },
  ],
});
