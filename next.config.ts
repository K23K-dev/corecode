import type { NextConfig } from 'next';

const config: NextConfig = {
  poweredByHeader: false,
  devIndicators: false,
  serverExternalPackages: ['pg', 'esbuild', '@vercel/sandbox'],
  outputFileTracingIncludes: {
    '/api/**': [
      './node_modules/react/**',
      './node_modules/react-dom/**',
      './node_modules/scheduler/**',
    ],
  },
};

export default config;
