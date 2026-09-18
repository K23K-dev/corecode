import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  serverExternalPackages: ['pg', '@vercel/sandbox', 'esbuild'],
  outputFileTracingIncludes: {
    '/api/**': [
      './node_modules/react/**',
      './node_modules/react-dom/**',
      './node_modules/scheduler/**',
    ],
  },
};

export default config;
