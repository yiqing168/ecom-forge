import type { NextConfig } from 'next';

const apiInternalOrigin = (process.env.API_INTERNAL_ORIGIN ?? 'http://127.0.0.1:3001').replace(
  /\/$/,
  '',
);

const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1'],
  devIndicators: false,
  distDir: process.env.NEXT_DIST_DIR ?? '.next',
  poweredByHeader: false,
  experimental: {
    // The `/api/v1/:path*` rewrite below proxies to the API, and Next buffers the
    // request body to do so. The proxy default is 10 MiB, which is below the 20 MB
    // image upload limit that the API (storageMaxImageBytes) and the web client
    // (MAX_ASSET_UPLOAD_BYTES) both advertise. Anything larger was rejected here with
    // a bare 500 before it ever reached the API. Keep this above that limit.
    proxyClientMaxBodySize: 21 * 1024 * 1024,
  },
  rewrites() {
    return Promise.resolve([
      {
        source: '/api/v1/:path*',
        destination: `${apiInternalOrigin}/api/v1/:path*`,
      },
    ]);
  },
  transpilePackages: ['@ecom-forge/shared', '@ecom-forge/types'],
};

export default nextConfig;
