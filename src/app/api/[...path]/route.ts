import { after } from 'next/server';
import { createApiHandler } from '../../../../server/index.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const api = createApiHandler({
  keepAlive: (task) =>
    after(async () => {
      await task;
    }),
});

function handle(request: Request) {
  const pending = api(request);
  // Retain transaction completion and durable job acceptance after disconnect.
  after(async () => {
    await pending;
  });
  return pending;
}

export {
  handle as GET,
  handle as POST,
  handle as PUT,
  handle as PATCH,
  handle as DELETE,
  handle as HEAD,
  handle as OPTIONS,
};
