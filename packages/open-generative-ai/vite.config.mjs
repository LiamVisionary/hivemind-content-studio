import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
    base: './',
    plugins: [react()],
    // Force a SINGLE React instance across the app, react-hot-toast, and goober.
    // Without this, Vite's dev optimizer resolves the app's ESM `react/jsx-runtime`
    // and react-hot-toast's CJS `require('react')` to two distinct module objects;
    // they don't share React's dispatcher, so the Toaster throws "Invalid hook
    // call". Absolute-path aliases + dedupe collapse them to one file.
    resolve: {
        dedupe: ['react', 'react-dom'],
        alias: {
            react: r('./node_modules/react'),
            'react-dom': r('./node_modules/react-dom'),
        },
    },
    optimizeDeps: {
        include: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react-hot-toast'],
    },
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
