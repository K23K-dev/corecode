import http from 'node:http';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const APP_ORIGIN = 'http://127.0.0.1:5173';
export const RUNNER_ORIGIN = 'http://127.0.0.1:4174';
export const PYODIDE_VERSION = '314.0.6';
const directory = path.dirname(fileURLToPath(import.meta.url));
const runtime = path.resolve(directory, '../../node_modules/pyodide');
const basePolicy = `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; script-src-attr 'none'; connect-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${APP_ORIGIN}`;
export const DOCUMENT_CSP = `${basePolicy}; worker-src 'self'`;
export const WORKER_CSP = `${basePolicy}; worker-src 'none'`;
const assets = new Map([
  ['/runner.html', [directory, 'runner.html', 'text/html; charset=utf-8']],
  ['/bridge.js', [directory, 'bridge.js', 'text/javascript; charset=utf-8']],
  ['/worker.js', [directory, 'worker.js', 'text/javascript; charset=utf-8']],
  ['/grader.py', [directory, 'grader.py', 'text/plain; charset=utf-8']],
  ['/pyodide/pyodide.js', [runtime, 'pyodide.js', 'text/javascript; charset=utf-8']],
  ['/pyodide/pyodide.asm.mjs', [runtime, 'pyodide.asm.mjs', 'text/javascript; charset=utf-8']],
  ['/pyodide/pyodide.asm.wasm', [runtime, 'pyodide.asm.wasm', 'application/wasm']],
  ['/pyodide/python_stdlib.zip', [runtime, 'python_stdlib.zip', 'application/zip']],
  ['/pyodide/pyodide-lock.json', [runtime, 'pyodide-lock.json', 'application/json']],
]);

export async function startRunnerServer() {
  const packageInfo = JSON.parse(await readFile(path.join(runtime, 'package.json'), 'utf8'));
  if (packageInfo.version !== PYODIDE_VERSION)
    throw new Error(`Runner requires pyodide ${PYODIDE_VERSION}`);
  // Resolve the small fixed file set once. No URL is ever turned into a file path.
  const resolvedAssets = new Map();
  for (const [url, [root, filename, type]] of assets) {
    const resolvedRoot = await realpath(root);
    const file = await realpath(path.join(root, filename));
    const relative = path.relative(resolvedRoot, file);
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new Error('Runtime asset leaves its allowed directory');
    resolvedAssets.set(url, { file, type });
  }
  const server = http.createServer(async (request, response) => {
    response.setHeader(
      'Content-Security-Policy',
      request.url === '/worker.js' ? WORKER_CSP : DOCUMENT_CSP,
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), clipboard-read=(), clipboard-write=()',
    );
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // Deliberately no Access-Control-Allow-Origin or arbitrary CORS preflight.
    if (request.headers.host !== '127.0.0.1:4174') {
      response.writeHead(403).end('Host not allowed');
      return;
    }
    if (request.headers.origin && request.headers.origin !== RUNNER_ORIGIN) {
      response.writeHead(403).end('Origin not allowed');
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
      return;
    }
    const asset = resolvedAssets.get(request.url);
    if (!asset) {
      response.writeHead(404).end('Not found');
      return;
    }
    try {
      const bytes = await readFile(asset.file);
      response.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': bytes.length });
      response.end(request.method === 'HEAD' ? undefined : bytes);
    } catch {
      response.writeHead(500).end('Runner asset unavailable');
    }
  });
  server.on('upgrade', (_request, socket) => socket.destroy());
  server.requestTimeout = 10_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(4174, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startRunnerServer()
    .then(() => console.log(`Python runner listening at ${RUNNER_ORIGIN}`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
