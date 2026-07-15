/** @type {import('next').NextConfig} */
const BACKEND = 'http://127.0.0.1:8787';

const nextConfig = {
  reactStrictMode: true,
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      { source: '/healthz', destination: `${BACKEND}/health` },
      { source: '/health', destination: `${BACKEND}/health` },
      { source: '/ws', destination: 'http://127.0.0.1:8188/ws' },
    ];
  },
};

module.exports = nextConfig;
