import { APIError, Sandbox, type Session } from '@vercel/sandbox';
import { setTimeout as delay } from 'node:timers/promises';
import { createJudgeClient, type JudgeClient, type JudgeClientResolver } from './client';

// Exit codes from judge/start-hosted.sh, installed in the VM as /opt/corecode/boot.sh.
const JUDGE_DRAINED = 0; // This command's judge ran and drained normally.
const ANOTHER_OWNER = 75; // Another command holds the boot lock and runs the judge.
const SESSION_DONE = 76; // This session's judge already finished; start a new session.

type Boot = { session: Session; client: JudgeClient; exitCode: () => number | undefined };

/** Vercel is stopping, snapshotting, or replacing the session: retry instead of failing. */
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

async function retryLater(error: unknown, signal: AbortSignal): Promise<undefined> {
  if (!changingSession(error)) throw error;
  await delay(500, undefined, { signal });
  return undefined;
}

async function stopSession(session: Session, signal?: AbortSignal) {
  try {
    await session.stop({ signal });
  } catch (error) {
    if (!(error instanceof APIError && error.response.status === 404) && !changingSession(error))
      throw error;
  }
}

/** Follow `promise`, but let this caller's signal reject early without canceling it. */
function unlessAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}

/** One persistent VM/image store serves both websites; Neon remains the queue. */
export function createSandboxJudgeResolver({
  name,
  token,
  databaseURL,
  credentials,
  keepAlive,
}: {
  name: string;
  token: string;
  databaseURL: string;
  credentials: { token?: string; teamId?: string; projectId?: string };
  keepAlive: (task: Promise<unknown>) => void;
}): JudgeClientResolver {
  let starting: Promise<JudgeClient> | undefined;
  let current: { sessionID: string; client: JudgeClient; expiresAt: number } | undefined;

  async function reuseCurrentClient() {
    const cached = current;
    if (!cached || cached.expiresAt <= Date.now()) return;
    try {
      const healthy = (await cached.client.checkHealth()) === 'SERVING';
      if (healthy && current === cached && cached.expiresAt > Date.now()) return cached.client;
    } catch {
      // A stopped or draining judge follows the normal session recovery.
    }
  }

  /** Wake the VM and run boot.sh, which starts the judge or reports who owns it. */
  async function bootSession(signal: AbortSignal): Promise<Boot | undefined> {
    let box;
    try {
      box = await Sandbox.get({ ...credentials, name, signal });
      await box.runCommand('true', [], { timeoutMs: 5000, signal });
    } catch (error) {
      return retryLater(error, signal);
    }
    const session = box.currentSession();
    const expiresAt = box.expiresAt;
    if (!expiresAt) throw new Error('The hosted judge session has no expiration.');
    const remaining = expiresAt.getTime() - Date.now();
    if (remaining < 15_000) {
      // The prior judge has already drained; wait for the VM's final cutoff.
      await delay(1000, undefined, { signal });
      return;
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
      return retryLater(error, signal);
    }
    const completion = command.wait();
    // Next's after() retains this cleanup beyond the HTTP response. A function
    // crash is still bounded by the independent four-minute VM timeout.
    keepAlive(
      completion
        .then(async (result) => {
          if (result.exitCode === ANOTHER_OWNER) return; // That owner's judge keeps running.
          if (current?.sessionID === session.sessionId) {
            current.client.close();
            current = undefined;
          }
          if (result.exitCode !== SESSION_DONE) await stopSession(session);
        })
        .catch(() => console.warn('Judge session cleanup will fall back to its VM timeout.')),
    );
    let exitCode: number | undefined;
    void completion
      .then((result) => {
        exitCode = result.exitCode;
      })
      .catch(() => {});
    if (current?.sessionID !== session.sessionId) {
      current?.client.close();
      current = {
        sessionID: session.sessionId,
        client: createJudgeClient(box.domain(8080), token),
        expiresAt: expiresAt.getTime(),
      };
    }
    return { session, client: current.client, exitCode: () => exitCode };
  }

  /** Poll health until the judge serves, or return nothing to retry the session. */
  async function waitUntilServing(
    { session, client, exitCode }: Boot,
    until: number,
    signal: AbortSignal,
  ) {
    for (let attempt = 0; Date.now() < until; attempt++) {
      const exited = exitCode();
      if (exited === SESSION_DONE) {
        // The boot lock and done marker prove this exact session finished.
        // A later caller can finish cleanup if the original Function died.
        await stopSession(session, signal);
        await delay(500, undefined, { signal });
        return;
      }
      if (exited === JUDGE_DRAINED) {
        await stopSession(session, signal);
        return;
      }
      if (exited !== undefined && exited !== ANOTHER_OWNER)
        throw new Error('The hosted judge could not start. Check its sandbox setup.');
      try {
        if ((await client.checkHealth()) === 'SERVING') return client;
      } catch {}
      if (exitCode() === ANOTHER_OWNER && attempt % 4 === 3) {
        // The owner may have drained since this caller found its session;
        // rerunning boot.sh rechecks the lock and done marker.
        let latest;
        try {
          latest = await Sandbox.get({ ...credentials, name, signal });
        } catch (error) {
          if (changingSession(error)) return;
          throw error;
        }
        const unchanged =
          latest.currentSession().sessionId === session.sessionId && latest.status === 'running';
        if (unchanged) await delay(500, undefined, { signal });
        return;
      }
      await delay(500, undefined, { signal });
    }
  }

  async function wake() {
    const reused = await reuseCurrentClient();
    if (reused) return reused;
    // Never silently replace an expired/deleted sandbox: its Docker engine and
    // pinned images belong to this queue. Setup/rebinding is an explicit action.
    const until = Date.now() + 90_000;
    const signal = AbortSignal.timeout(90_000);
    while (Date.now() < until) {
      const boot = await bootSession(signal);
      const client = boot && (await waitUntilServing(boot, until, signal));
      if (client) return client;
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
    return unlessAborted(starting, signal);
  };
}
