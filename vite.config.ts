import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    // Keep Vite's default sensitive-file protections and exclude private data.
    fs: {
      deny: [
        '.env',
        '.env.*',
        '*.{crt,pem,key,p12,pfx,cer,der}',
        '.npmrc',
        '.yarnrc.yml',
        '**/.git/**',
        '**/.local/**',
        '**/runner/**',
        '**/tests/**',
        '**/server/**',
        '**/data/exercises.json',
      ],
    },
    watch: { ignored: ['**/.local/**'] },
    proxy: { '/api': { target: 'http://127.0.0.1:4175', changeOrigin: true } },
  },
  preview: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: 'http://127.0.0.1:4175', changeOrigin: true } },
  },
});
