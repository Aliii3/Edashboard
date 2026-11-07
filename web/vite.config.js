import { defineConfig } from 'vite';
export default defineConfig({ server: { port: 5173, proxy: { '/api': 'http://localhost:3001' } }, build: { outDir: 'dist', emptyOutDir: true, target: 'es2022' } });
