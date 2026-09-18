import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';

const API_PORT = Number(process.env.API_PORT ?? 8787);

/**
 * 局域网访问：`--host` 或 DEV_ALLOW_LAN=1 时监听 0.0.0.0。
 * HMR 显式指向同一台机器的局域网地址——否则其他设备加载页面后
 * HMR 的 WebSocket 可能连不上（只是警告，但配置后更干净）。
 */
const allowLan = process.env.DEV_ALLOW_LAN === '1' || process.argv.includes('--host');

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src/web', import.meta.url)),
      '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // true 等价于监听 0.0.0.0
    host: allowLan ? true : '127.0.0.1',
    ...(allowLan && process.env.DEV_HMR_HOST ? { hmr: { host: process.env.DEV_HMR_HOST } } : {}),
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${API_PORT}`,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist/web',
    sourcemap: true,
  },
});
