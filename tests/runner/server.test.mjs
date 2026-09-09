import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  startRunnerServer,
  DOCUMENT_CSP,
  WORKER_CSP,
  RUNNER_ORIGIN,
} from '../../runner/browser-python/server.mjs';

function request(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${RUNNER_ORIGIN}${urlPath}`, options, (response) => {
      const parts = [];
      response.on('data', (data) => parts.push(data));
      response.on('end', () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(parts),
        }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

test('runner serves only fixed assets with document and worker CSP', async () => {
  const server = await startRunnerServer();
  try {
    assert.equal(server.address().address, '127.0.0.1');
    for (const route of [
      '/runner.html',
      '/bridge.js',
      '/worker.js',
      '/grader.py',
      '/pyodide/pyodide.js',
      '/pyodide/pyodide.asm.mjs',
      '/pyodide/pyodide.asm.wasm',
      '/pyodide/python_stdlib.zip',
      '/pyodide/pyodide-lock.json',
    ]) {
      const result = await request(route);
      assert.equal(result.status, 200, route);
      assert(result.body.length > 0);
      assert.equal(result.headers['x-content-type-options'], 'nosniff');
      assert.equal(result.headers['access-control-allow-origin'], undefined);
      assert.equal(
        result.headers['content-security-policy'],
        route === '/worker.js' ? WORKER_CSP : DOCUMENT_CSP,
      );
    }
    assert(DOCUMENT_CSP.includes('frame-ancestors http://127.0.0.1:5173'));
    assert(WORKER_CSP.includes("worker-src 'none'"));
    assert(WORKER_CSP.includes("connect-src 'self'"));
    assert(WORKER_CSP.includes("'wasm-unsafe-eval'"));
    assert(!WORKER_CSP.includes("'unsafe-eval'"));
    for (const route of [
      '/',
      '/package.json',
      '/src/lib/runner.ts',
      '/data/python.json',
      '/pyodide/package.json',
      '/pyodide/console.html',
      '/runner.html?secret=1',
      '/%2e%2e/package.json',
      '/.env',
    ]) {
      assert.equal((await request(route)).status, 404, route);
    }
    assert.equal((await request('/worker.js', { method: 'POST' })).status, 405);
    assert.equal((await request('/worker.js', { method: 'OPTIONS' })).status, 405);
    assert.equal(
      (await request('/worker.js', { headers: { Host: 'evil.example:4174' } })).status,
      403,
    );
    assert.equal(
      (await request('/worker.js', { headers: { Origin: 'http://127.0.0.1:5173' } })).status,
      403,
    );
    assert.equal(
      (await request('/worker.js', { headers: { Origin: 'https://evil.example' } })).status,
      403,
    );
    assert.equal((await request('/worker.js', { method: 'HEAD' })).body.length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
