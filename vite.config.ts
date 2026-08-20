import { defineConfig } from 'vite';
import { WS_PORT } from './src/shared/constants.js';

export default defineConfig({
  server: {
    host: true,
    port: 5174,
    // Dev convenience: lets a tunnel hostname (trycloudflare, ngrok, …) through.
    allowedHosts: true,
    proxy: {
      // The game socket rides the same origin as the page: one port to share,
      // and an https tunnel upgrades it to wss automatically instead of the
      // browser blocking a plain ws:// from a secure page.
      '/ws': {
        target: `ws://127.0.0.1:${WS_PORT}`,
        ws: true,
        rewrite: (p) => p.replace(/^\/ws/, ''),
      },
    },
  },
});
