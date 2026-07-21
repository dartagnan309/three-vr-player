import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'demo',
  resolve: { alias: { 'three-vr-player': resolve(__dirname, 'src/index.ts') } },
  server: { port: 8080, host: true, allowedHosts: ['.trycloudflare.com'] },
  build: {
    outDir: '../dist-demo', emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'demo/index.html'),
        gallery: resolve(__dirname, 'demo/gallery/index.html'),
      },
    },
  },
});
