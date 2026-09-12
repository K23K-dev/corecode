import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { createApp } from '../server/app.mjs';
import { checkedOrigin, errorResponse } from '../server/http.mjs';
import { makePool } from '../server/repository.mjs';
import { RequestError } from '../server/validation.mjs';

export { initializeDatabase } from '../server/repository.mjs';

/** Test-only TCP adapter. Next supplies this transport in the real application. */
export function requestListener(handle) {
  return async (incoming, outgoing) => {
    const controller = new AbortController();
    const cancel = () => {
      if (!outgoing.writableEnded) controller.abort();
    };
    outgoing.once('close', cancel);
    try {
      if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')) {
        throw new RequestError('Invalid request path.');
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
      }
      const request = new Request(new URL(incoming.url, 'http://127.0.0.1'), {
        method: incoming.method,
        headers,
        signal: controller.signal,
        ...(!['GET', 'HEAD'].includes(incoming.method)
          ? { body: Readable.toWeb(incoming), duplex: 'half' }
          : {}),
      });
      const response = await handle(request);
      if (outgoing.destroyed) return;
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      if (outgoing.destroyed) return;
      const response = errorResponse(error, incoming.method === 'HEAD');
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    } finally {
      outgoing.off('close', cancel);
      incoming.resume();
    }
  };
}

/** Real-database tests still own and close their isolated pool explicitly. */
export async function startDataServer({
  connectionString,
  port = 0,
  appOrigin = 'http://127.0.0.1:5173',
}) {
  checkedOrigin(appOrigin);
  const pool = makePool(connectionString);
  const server = createServer(requestListener(createApp({ pool, appOrigin })));
  const originalClose = server.close.bind(server);
  let closing;
  server.close = (callback) => {
    closing ??= new Promise((resolve, reject) =>
      originalClose((error) => pool.end().then(() => (error ? reject(error) : resolve()), reject)),
    );
    if (callback) closing.then(() => callback(), callback);
    return server;
  };
  try {
    await pool.query('SELECT 1');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    return server;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
