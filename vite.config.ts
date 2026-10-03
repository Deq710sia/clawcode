import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

/**
 * index.html ships a strict production CSP (no inline scripts). The Vite dev server needs
 * an inline React-Refresh preamble and a websocket for HMR, which that CSP blocks and
 * leaves a blank window in `npm run dev`. Relax it for the dev server only.
 */
const devCsp = (): Plugin => ({
  name: 'clawcode-dev-csp',
  apply: 'serve',
  transformIndexHtml(html) {
    return html.replace(
      /<meta http-equiv="Content-Security-Policy"[^>]*>/,
      `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:5173 http://127.0.0.1:5173" />`
    );
  },
});

export default defineConfig({
  plugins: [react(), devCsp()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
