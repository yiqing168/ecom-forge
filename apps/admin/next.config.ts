import type { NextConfig } from 'next';

const apiInternalOrigin = (process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3001').replace(
  /\/$/,
  '',
);

// Admin routes proxy long-running control-plane calls (model POC, asset processing retries) that
// legitimately take minutes; the Next.js default proxy timeout is far below that.
export const ADMIN_API_PROXY_TIMEOUT_MS = 300_000;

const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  devIndicators: false,
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  experimental: {
    proxyTimeout: ADMIN_API_PROXY_TIMEOUT_MS,
  },
  poweredByHeader: false,
  transpilePackages: ['@ecom-forge/shared'],
  rewrites() {
    return Promise.resolve([
      {
        source: '/api/v1/admin/:path*',
        destination: `${apiInternalOrigin}/api/v1/admin/:path*`,
      },
    ]);
  },
};

export default nextConfig;
