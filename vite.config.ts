import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [dts({ include: ['src'], rollupTypes: false })],
  build: {
    lib: {
      entry: {
        'three-vr-player': resolve(__dirname, 'src/index.ts'),
        core: resolve(__dirname, 'src/core/index.ts'),
      },
      formats: ['es'],
    },
    rollupOptions: {
      external: ['three', /^three\//, 'hls.js'],
      output: { assetFileNames: 'three-vr-player.[ext]' },
    },
    sourcemap: true,
    emptyOutDir: true,
  },
});
