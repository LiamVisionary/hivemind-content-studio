import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const r = (p) => fileURLToPath(new URL(p, import.meta.url));

// One version number for the whole product, read from pyproject.toml — see
// scripts/projectVersion.cjs. The topbar chip and the About page use THIS, and
// /api/version reads the same file through Python's package metadata, so the two
// halves of the app cannot disagree about which build someone is running.
const { projectVersion } = createRequire(import.meta.url)('./scripts/projectVersion.cjs');

export default defineConfig({
    base: './',
    define: {
        __APP_VERSION__: JSON.stringify(projectVersion()),
    },
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
    build: {
        rollupOptions: {
            output: {
                // React and the toaster change when we upgrade them, not when we
                // edit the app. Left inlined they rode in index-<hash>.js, whose
                // hash moves on every release — so the immutable-cache header the
                // control API sets on /assets was never able to help, and every
                // update re-downloaded the framework. Split out, the vendor hash
                // survives an app-only rebuild and comes straight from cache.
                // `react-dom/client` is listed alongside `react-dom` on purpose:
                // the app imports the client entry, which pulls
                // react-dom-client.production.js — a different file from the one
                // `react-dom` (index.js) reaches. Name only the package and the
                // 180 KB half of React stays in the app chunk, which is the
                // whole thing this split exists to move.
                manualChunks: { vendor: ['react', 'react-dom', 'react-dom/client', 'react-hot-toast'] },
            },
        },
    },
    server: {
        proxy: {
            // Dev-only: forward studio API calls to the local control API so
            // the hub views work on the vite dev server. Machine-allowed
            // routes respond without an owner session; owner-gated routes 401.
            // OPENGEN_API_PROXY points the same proxy at a fixture/mock API for
            // owner-gate-free UI verification; unset, nothing changes.
            '/api': {
                target: process.env.OPENGEN_API_PROXY || 'http://127.0.0.1:8765',
                changeOrigin: true,
            },
            // The status heartbeat. Without this the dev server would answer
            // /healthz with index.html and the whole app would read "Ready"
            // whatever the studio is actually doing.
            '/healthz': {
                target: process.env.OPENGEN_API_PROXY || 'http://127.0.0.1:8765',
                changeOrigin: true,
            },
            // Local-AI bridge straight to the loopback hosted-server (8794).
            // The bridge is gated now (the same canvas-gate credential the
            // Canvas surface uses), and the dev server needs no extra setup for
            // it: cookies are scoped by host and not by port, so a browser
            // signed in to the studio on 127.0.0.1:8765 sends its session
            // cookie here too, and this proxy forwards it.
            '/local-ai': {
                target: 'http://127.0.0.1:8794',
                changeOrigin: true,
            },
        }
    }
});
