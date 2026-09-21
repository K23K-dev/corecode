import { Sandbox } from '@vercel/sandbox';
import { setTimeout as delay } from 'node:timers/promises';

function changingSession(error) {
  const status = error?.response?.status;
  const code = error?.json?.error?.code;
  return (
    (status === 410 && code !== 'snapshot_not_found') ||
    (status === 422 && ['sandbox_stopping', 'sandbox_snapshotting'].includes(code))
  );
}

async function stopSession(session, signal) {
  try {
    await session.stop({ signal });
  } catch (error) {
    if (error?.response?.status !== 404 && !changingSession(error)) throw error;
  }
}

export function sandboxCredentials(environment = process.env) {
  const { VERCEL_TOKEN: token, VERCEL_TEAM_ID: teamId, VERCEL_PROJECT_ID: projectId } = environment;
  if (token) {
    if (!teamId || !projectId)
      throw new Error('Provide VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID together.');
    return { token, teamId, projectId };
  }
  return {}; // Project-scoped OIDC on Vercel and in linked local development.
}

/** One persistent VM/image store serves both websites; Neon remains the queue. */
export function createSandboxJudgeResolver({
  name,
  token,
  databaseURL,
  credentials = sandboxCredentials(),
  keepAlive = (task) => void task,
}) {
  let starting;
  let current;
  async function wake() {
    const { createJudgeClient } = await import('./client.ts');
    // Never silently replace an expired/deleted sandbox: its Docker engine and
    // pinned images belong to this queue. Setup/rebinding is an explicit action.
    const until = Date.now() + 90_000;
    const signal = AbortSignal.timeout(90_000);
    sessionLoop: while (Date.now() < until) {
      let box;
      try {
        box = await Sandbox.get({ ...credentials, name, signal });
        await box.runCommand('true', [], { timeoutMs: 5000, signal });
      } catch (error) {
        if (!changingSession(error)) throw error;
        await delay(500, undefined, { signal });
        continue;
      }
      const session = box.currentSession();
      const remaining = box.expiresAt.getTime() - Date.now();
      if (remaining < 15_000) {
        // The prior judge has already drained; wait for the VM's final cutoff.
        await delay(1000, undefined, { signal });
        continue;
      }
      let command;
      try {
        // Session calls never auto-resume onto a different VM mid-dispatch.
        command = await session.runCommand({
          cmd: '/opt/corecode/boot.sh',
          sudo: true,
          detached: true,
          signal,
          timeoutMs: Math.min(225_000, remaining - 10_000),
          env: {
            POSTGRES_URL: databaseURL,
            JUDGE_TOKEN: token,
            JUDGE_SANDBOX_DEADLINE: String(
              Math.min(Date.now() + 180_000, box.expiresAt.getTime() - 50_000),
            ),
            CORECODE_SESSION_ID: session.sessionId,
          },
        });
      } catch (error) {
        if (!changingSession(error)) throw error;
        await delay(500, undefined, { signal });
        continue;
      }
      const completion = command.wait();
      // Next's after() retains this task beyond the HTTP response. A function
      // crash is still bounded by the independent four-minute VM timeout.
      keepAlive(
        completion
          .then(async (result) => {
            if (result.exitCode !== 75 && result.exitCode !== 76) await stopSession(session);
          })
          .catch(() => console.warn('Judge session cleanup will fall back to its VM timeout.')),
      );
      let exited;
      void completion
        .then((result) => {
          exited = result.exitCode;
        })
        .catch(() => {});
      if (current?.sessionID !== session.sessionId) {
        current?.client.close();
        current = {
          sessionID: session.sessionId,
          client: createJudgeClient(box.domain(8080), { token, protocol: 'grpc-web' }),
        };
      }
      const client = current.client;
      for (let attempt = 0; Date.now() < until; attempt++) {
        if (exited === 76) {
          // The boot lock and done marker prove this exact session finished.
          // A later caller can finish cleanup if the original Function died.
          await stopSession(session, signal);
          await delay(500, undefined, { signal });
          continue sessionLoop;
        }
        if (exited === 0) {
          await stopSession(session, signal);
          continue sessionLoop;
        }
        if (exited !== undefined && exited !== 75)
          throw new Error('The hosted judge could not start. Check its sandbox setup.');
        try {
          if ((await client.checkHealth()) === 'SERVING') return client;
        } catch {}
        if (exited === 75 && attempt % 4 === 3) {
          let latest;
          try {
            latest = await Sandbox.get({ ...credentials, name, signal });
          } catch (error) {
            if (changingSession(error)) continue sessionLoop;
            throw error;
          }
          if (
            latest.currentSession().sessionId !== session.sessionId ||
            latest.status !== 'running'
          )
            continue sessionLoop;
          // Recheck the boot marker periodically: the existing owner may have
          // drained between discovering its session and checking health.
          await delay(500, undefined, { signal });
          continue sessionLoop;
        }
        await delay(500, undefined, { signal });
      }
    }
    throw new Error('The hosted judge is restarting. Try again shortly.');
  }
  return async ({ signal } = {}) => {
    signal?.throwIfAborted();
    if (!starting) {
      starting = wake().finally(() => {
        starting = undefined;
      });
      // A canceled Run detaches only its caller, leaving a shared wake alive.
      keepAlive(starting.catch(() => {}));
    }
    if (!signal) return starting;
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      starting.then(
        (client) => {
          signal.removeEventListener('abort', abort);
          resolve(client);
        },
        (error) => {
          signal.removeEventListener('abort', abort);
          reject(error);
        },
      );
      if (signal.aborted) abort();
    });
  };
}
