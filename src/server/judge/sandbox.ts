import { APIError, Sandbox, type Session } from '@vercel/sandbox';
import { setTimeout as delay } from 'node:timers/promises';
import type { JudgeClient } from './client.ts';
import type { JudgeClientResolver } from './adapter.ts';

function changingSession(error: unknown) {
  if (!(error instanceof APIError)) return false;
  const status = error.response.status;
  const json: unknown = error.json;
  const detail =
    json !== null && typeof json === 'object' && 'error' in json ? json.error : undefined;
  const code =
    detail !== null && typeof detail === 'object' && 'code' in detail ? detail.code : undefined;
  return (
    (status === 410 && code !== 'snapshot_not_found') ||
    (status === 422 && (code === 'sandbox_stopping' || code === 'sandbox_snapshotting'))
  );
}

async function stopSession(session: Session, signal?: AbortSignal) {
  try {
    await session.stop({ signal });
  } catch (error) {
    if (!(error instanceof APIError && error.response.status === 404) && !changingSession(error))
      throw error;
  }
}

export function sandboxCredentials(environment: Record<string, string | undefined> = process.env) {
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
}: {
  name: string;
  token: string;
  databaseURL: string;
  credentials?: ReturnType<typeof sandboxCredentials>;
  keepAlive?: (task: Promise<unknown>) => void;
}): JudgeClientResolver {
  let starting: Promise<JudgeClient> | undefined;
  let current: { sessionID: string; client: JudgeClient } | undefined;
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
      const expiresAt = box.expiresAt;
      if (!expiresAt) throw new Error('The hosted judge session has no expiration.');
      const remaining = expiresAt.getTime() - Date.now();
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
              Math.min(Date.now() + 180_000, expiresAt.getTime() - 50_000),
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
      let exited: number | undefined;
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
    const wakeup = starting;
    if (!signal) return wakeup;
    return new Promise<JudgeClient>((resolve, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener('abort', abort, { once: true });
      wakeup.then(
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
