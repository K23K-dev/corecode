import { after } from 'next/server';
import { router } from '../../../server/router';

/** Hands every /api request to the router, and lets its work finish if the browser disconnects. */
async function handle(request: Request) {
  const response = router.fetch(request);
  after(async () => {
    await response;
  });
  return response;
}

export { handle as GET, handle as POST, handle as PUT };
