import { after } from 'next/server';
import { createApiHandler } from '../../../../server/index.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const api = createApiHandler();

function handle(request: Request) {
  const pending = api(request);
  // Retain in-flight transaction completion and sandbox cleanup after disconnect.
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
