import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// Standalone <script> build: three AND hls.js are bundled in (no import map / no
// peer deps needed), dynamic import inlined. Larger, but truly drop-in for CDN use.
export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'ThreeVrPlayer',
      formats: ['iife'],
      fileName: () => 'three-vr-player.standalone.js',
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
    emptyOutDir: false, // keep the ESM build produced by vite.config.ts
    sourcemap: true,
  },
});
