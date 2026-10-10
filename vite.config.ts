import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // The API server reads PORT from the root .env; the dev proxy has to target the same port.
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const serverPort = Number(env.PORT || 4848);
  return {
    root: 'src/web',
    plugins: [react()],
    build: {
      outDir: '../../dist/web',
      emptyOutDir: true,
    },
    server: {
      host: '127.0.0.1',
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': `http://127.0.0.1:${serverPort}`,
        '/ws': { target: `ws://127.0.0.1:${serverPort}`, ws: true },
      },
    },
  };
});
