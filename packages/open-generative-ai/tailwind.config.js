/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                // ---- Hive system (v3) ----
                bg0: 'var(--bg-0)',
                bg1: 'var(--bg-1)',
                bg2: 'var(--bg-2)',
                bg3: 'var(--bg-3)',
                line1: 'var(--line-1)',
                line2: 'var(--line-2)',
                ink1: 'var(--ink-1)',
                ink2: 'var(--ink-2)',
                ink3: 'var(--ink-3)',
                honey: {
                    DEFAULT: 'var(--honey)',
                    bright: 'var(--honey-bright)',
                    deep: 'var(--honey-deep)',
                },
                'honey-tint': 'var(--honey-tint)',
                'on-honey': 'var(--on-honey)',
                ok: { DEFAULT: 'var(--ok)' },
                'ok-tint': 'var(--ok-tint)',
                warn: { DEFAULT: 'var(--warn)' },
                info: { DEFAULT: 'var(--info)' },
                scrim: 'var(--bg-scrim)',

                // ---- Legacy aliases (old vanilla components during the port;
                //      remove together with the old files) ----
                primary: {
                    DEFAULT: 'var(--honey)',
                    hover: 'var(--honey-bright)',
                },
                accent: {
                    DEFAULT: 'var(--honey-bright)',
                    hover: 'var(--honey-bright)',
                },
                'app-bg': 'var(--bg-0)',
                'panel-bg': 'var(--bg-1)',
                'card-bg': 'var(--bg-2)',
                'elevated-bg': 'var(--bg-3)',
                secondary: 'var(--ink-2)',
                muted: 'var(--ink-3)',
                success: 'var(--ok)',
                danger: { DEFAULT: 'var(--danger)' },
                'danger-tint': 'var(--danger-tint)',
            },
            fontFamily: {
                sans: ['"Inter Variable"', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
                display: ['"Inter Variable"', 'Inter', 'system-ui', 'sans-serif'],
                mono: ['ui-monospace', '"SF Mono"', '"JetBrains Mono"', 'Menlo', 'monospace'],
            },
            borderRadius: {
                sm: 'var(--r-sm)',
                md: 'var(--r-md)',
                lg: 'var(--r-lg)',
                xl: 'var(--r-xl)',
                '2xl': '1.5rem',
                '3xl': '2rem',
            },
            boxShadow: {
                overlay: 'var(--shadow-overlay)',
                pop: 'var(--shadow-pop)',
                card: 'var(--shadow-card)',
                // legacy names
                glow: 'none',
                'glow-strong': 'none',
                'glow-accent': 'none',
                '3xl': '0 35px 60px -15px rgba(0, 0, 0, 0.8)',
                panel: 'var(--shadow-card)',
            },
            transitionTimingFunction: {
                swift: 'cubic-bezier(0.2, 0.9, 0.3, 1)',
            },
            height: {
                'ctl-sm': 'var(--ctl-sm)',
                'ctl-md': 'var(--ctl-md)',
                'ctl-lg': 'var(--ctl-lg)',
            },
        },
    },
    plugins: [],
}
