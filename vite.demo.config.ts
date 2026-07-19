import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  root: 'demo',
  resolve: { alias: { 'three-vr-player': resolve(__dirname, 'src/index.ts') } },
  server: { port: 8080, host: true },
  build: { outDir: '../dist-demo', emptyOutDir: true },
});
