import { defineConfig } from 'vite';

export default defineConfig({
    base: './',
    server: {
        proxy: {
            // Dev-only: forward studio API calls to the local control API so
            // the hub views work on the vite dev server. Machine-allowed
            // routes respond without an owner session; owner-gated routes 401.
            '/api': {
                target: 'http://127.0.0.1:8765',
                changeOrigin: true,
            },
            // Local-AI bridge straight to the loopback hosted-server (8794),
            // which is not owner-gated — local models and auto-detected
            // workflows work on the dev server with zero extra setup.
            '/local-ai': {
                target: 'http://127.0.0.1:8794',
                changeOrigin: true,
            },
        }
    }
});
