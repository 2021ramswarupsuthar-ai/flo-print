import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` serves the UI on :5173 and forwards /api to the local dev API (`npm run dev:api`, port 3001).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': 'http://localhost:3001' } },
  build: { outDir: 'dist', sourcemap: false },
});
