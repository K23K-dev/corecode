import { cleanupRuntime } from './database-runtime.mjs';

export default async function globalTeardown() {
  await cleanupRuntime();
}
