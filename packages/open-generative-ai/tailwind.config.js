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
                bg0: 'rgb(var(--bg-0-rgb) / <alpha-value>)',
                bg1: 'rgb(var(--bg-1-rgb) / <alpha-value>)',
                bg2: 'rgb(var(--bg-2-rgb) / <alpha-value>)',
                bg3: 'rgb(var(--bg-3-rgb) / <alpha-value>)',
                line1: 'var(--line-1)',
                line2: 'var(--line-2)',
                ink1: 'rgb(var(--ink-1-rgb) / <alpha-value>)',
                ink2: 'rgb(var(--ink-2-rgb) / <alpha-value>)',
                ink3: 'rgb(var(--ink-3-rgb) / <alpha-value>)',
                honey: {
                    DEFAULT: 'rgb(var(--honey-rgb) / <alpha-value>)',
                    bright: 'rgb(var(--honey-bright-rgb) / <alpha-value>)',
                    deep: 'rgb(var(--honey-deep-rgb) / <alpha-value>)',
                },
                // Translucent tokens: the modifier SCALES the base wash (bg-honey-tint/50 = half of 12%).
                'honey-tint': 'rgb(var(--honey-rgb) / calc(var(--honey-tint-a) * <alpha-value>))',
                'on-honey': 'rgb(var(--on-honey-rgb) / <alpha-value>)',
                ok: { DEFAULT: 'rgb(var(--ok-rgb) / <alpha-value>)' },
                'ok-tint': 'rgb(var(--ok-rgb) / calc(var(--ok-tint-a) * <alpha-value>))',
                warn: { DEFAULT: 'rgb(var(--warn-rgb) / <alpha-value>)' },
                info: { DEFAULT: 'rgb(var(--info-rgb) / <alpha-value>)' },
                scrim: 'var(--bg-scrim)',

                danger: { DEFAULT: 'rgb(var(--danger-rgb) / <alpha-value>)' },
                'danger-tint': 'rgb(var(--danger-rgb) / calc(var(--danger-tint-a) * <alpha-value>))',
            },
            fontFamily: {
                sans: ['"Inter Variable"', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
                display: ['"Inter Variable"', 'Inter', 'system-ui', 'sans-serif'],
                mono: ['ui-monospace', '"SF Mono"', '"JetBrains Mono"', 'Menlo', 'monospace'],
            },
            borderRadius: {
                DEFAULT: 'var(--r-sm)',
                sm: 'var(--r-sm)',
                md: 'var(--r-md)',
                lg: 'var(--r-lg)',
                xl: 'var(--r-xl)',
            },
            boxShadow: {
                overlay: 'var(--shadow-overlay)',
                pop: 'var(--shadow-pop)',
                card: 'var(--shadow-card)',
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
