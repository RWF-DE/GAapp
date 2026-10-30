import { defineConfig } from 'vite';
// GitHub Pages の https://<org>.github.io/<repo>/ を想定して、既定の base を /GAapp/ にする
export default defineConfig({
  root: 'browser',
  base: process.env.VITE_BASE ?? '/GAapp/',
  build: { outDir: '../dist', emptyOutDir: true, target: 'es2022' },
  worker: { format: 'es' },
  server: { port: 5199, strictPort: true },
});
