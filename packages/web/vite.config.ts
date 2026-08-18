import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API = process.env.CARICA_API ?? 'http://127.0.0.1:4417';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5317,
    proxy: {
      // SSE must not be buffered by the dev proxy, hence ws:false + no compression.
      '/api': { target: API, changeOrigin: true, ws: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
