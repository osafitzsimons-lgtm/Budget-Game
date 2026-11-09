import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import preact from '@preact/preset-vite';
import { defineConfig, type Plugin } from 'vite';

/** Bundle pdf.js font data locally so the browser never fetches anything from a CDN. */
function copyPdfJsData(): Plugin {
  return {
    name: 'copy-pdfjs-data',
    apply: 'build',
    closeBundle() {
      const src = resolve('node_modules/pdfjs-dist');
      for (const dir of ['standard_fonts', 'cmaps']) {
        const from = resolve(src, dir);
        const to = resolve('dist/pdfjs', dir);
        if (existsSync(from)) { mkdirSync(to, { recursive: true }); cpSync(from, to, { recursive: true }); }
      }
    },
  };
}

export default defineConfig({
  plugins: [preact(), copyPdfJsData()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: { main: resolve('index.html'), sw: resolve('src/web/sw.ts') },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
