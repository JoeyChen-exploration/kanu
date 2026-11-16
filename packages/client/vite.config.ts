import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发时：Discord 代理 → cloudflared 隧道 → 这里（5173），/api 再转给卡奴服务器（4790）。
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // 隧道域名每次都不一样（*.trycloudflare.com），放行所有 Host
    allowedHosts: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${process.env.PORT || 4790}`, changeOrigin: true },
    },
    // 热更新走 Discord 代理时是 https 443
    hmr: { clientPort: 443 },
  },
});
