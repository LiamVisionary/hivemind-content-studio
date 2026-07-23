/** @type {import('tailwindcss').Config} */
module.exports = {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
        "./app/**/*.{js,ts,jsx,tsx}",
        "./components/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                primary: {
                    DEFAULT: '#22d3ee',
                    hover: '#67e8f9',
                },
                accent: {
                    DEFAULT: '#a78bfa',
                    hover: '#c4b5fd',
                },
                'app-bg': '#0a0a0f',
                'panel-bg': '#101016',
                'card-bg': '#15151d',
                'elevated-bg': '#1a1a24',
                secondary: '#a7a7b8',
                muted: '#70707f',
                success: '#34d399',
                danger: '#f87171',
            },
            fontFamily: {
                sans: ['"Inter Variable"', 'Inter', 'system-ui', '-apple-system', 'sans-serif'],
                display: ['"Space Grotesk Variable"', '"Space Grotesk"', '"Inter Variable"', 'system-ui', 'sans-serif'],
            },
            borderRadius: {
                'xl': '1rem',
                '2xl': '1.5rem',
                '3xl': '2rem',
            },
            boxShadow: {
                'glow': '0 0 24px rgba(34, 211, 238, 0.25)',
                'glow-strong': '0 0 32px rgba(34, 211, 238, 0.45)',
                'glow-accent': '0 0 24px rgba(167, 139, 250, 0.3)',
                '3xl': '0 35px 60px -15px rgba(0, 0, 0, 0.8)',
                'panel': '0 1px 0 0 rgba(255,255,255,0.04) inset, 0 16px 40px -20px rgba(0,0,0,0.7)',
            }
        },
    },
    plugins: [],
}
