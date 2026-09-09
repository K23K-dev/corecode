import { createServer } from 'node:http';
import { createApp } from './app.mjs';
import { checkedOrigin } from './middleware/request-protection.mjs';
import { makePool } from './repository.mjs';

export { initializeDatabase } from './repository.mjs';

/** Start the loopback listener; the caller initializes the Neon schema first. */
export async function startDataServer({
  connectionString,
  port = 4175,
  host = '127.0.0.1',
  appOrigin = 'http://127.0.0.1:5173',
}) {
  if (!['127.0.0.1', '::1'].includes(host))
    throw new Error('The data listener must bind to loopback.');
  checkedOrigin(appOrigin);
  const pool = makePool(connectionString);
  try {
    const server = createServer(createApp({ pool, appOrigin }));
    server.requestTimeout = 20_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 1000;

    const originalClose = server.close.bind(server);
    let closing;
    server.close = (callback) => {
      if (!closing)
        closing = new Promise((resolve, reject) =>
          originalClose((error) => {
            pool.end().then(() => (error ? reject(error) : resolve()), reject);
          }),
        );
      if (callback) closing.then(() => callback(), callback);
      return server;
    };

    await pool.query('SELECT 1');
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
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
