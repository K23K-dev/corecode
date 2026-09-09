import { createServer, preview } from 'vite';
import { startRunnerServer } from '../runner/browser-python/server.mjs';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { getDatabaseConnection } from './database-config.mjs';
import { initializeDatabase, startDataServer } from './index.mjs';

process.chdir(fileURLToPath(new URL('../', import.meta.url)));
let runner;
let app;
let dataServer;
try {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const { connectionString } = getDatabaseConnection();
  runner = await startRunnerServer();
  await initializeDatabase(connectionString);
  dataServer = await startDataServer({ connectionString });
  if (process.argv.includes('--preview')) {
    app = await preview();
  } else {
    app = await createServer();
    await app.listen();
  }
  console.log(
    '\nCode Practice is ready: http://127.0.0.1:5173\nProgress is stored in Neon. Press Ctrl+C to stop the website servers.\n',
  );
} catch (error) {
  runner?.close();
  dataServer?.close();
  if (error.code === 'EADDRINUSE') {
    console.error('Code Practice could not start because a local port is already in use.');
    console.error('If Code Practice is already running, just open http://127.0.0.1:5173.');
    console.error('Otherwise, stop the older Code Practice terminal before starting it again.');
  } else
    console.error(
      `Could not start Code Practice: ${String(error.message).replace(/postgres(?:ql)?:\/\/\S+/gi, '[database connection]')}`,
    );
  process.exitCode = 1;
}
async function stop() {
  if (app?.close) await app.close();
  if (app?.httpServer) app.httpServer.close();
  runner?.close();
  if (dataServer) await new Promise((resolve) => dataServer.close(resolve));
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
