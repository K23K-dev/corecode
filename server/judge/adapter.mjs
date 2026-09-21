import { Code } from '@connectrpc/connect';
import { RequestError } from '../validation.mjs';

const states = ['', 'queued', 'running', 'canceling', 'completed', 'failed', 'canceled'];

function judgeError(error) {
  if (error instanceof RequestError) return error;
  const mapped = {
    [Code.InvalidArgument]: [400, 'invalid_request', 'The execution request is invalid.'],
    [Code.NotFound]: [404, 'not_found', 'The problem or submission was not found.'],
    [Code.AlreadyExists]: [
      409,
      'submission_conflict',
      'That submission ID belongs to different input. Check its saved result before retrying.',
    ],
    [Code.FailedPrecondition]: [
      409,
      'problem_changed',
      'The problem or grading setup changed. Refresh before trying again.',
    ],
    [Code.ResourceExhausted]: [
      429,
      'runner_busy',
      'Execution slots are busy or submissions are waiting. Try again shortly.',
    ],
    [Code.Canceled]: [499, 'canceled', 'The execution request was canceled.'],
    [Code.DeadlineExceeded]: [
      504,
      'judge_timeout',
      'The judge did not respond in time. Check the submission status before retrying.',
    ],
  }[error?.name === 'AbortError' ? Code.Canceled : error?.code] ?? [
    503,
    'judge_unavailable',
    'The judge is unavailable. Try again shortly or check its server configuration.',
  ];
  return new RequestError(mapped[2], mapped[0], mapped[1]);
}

function result(value) {
  return {
    cases: (value.cases ?? []).map((entry) => ({
      name: entry.name,
      input: entry.input,
      ...(entry.expected !== undefined ? { expected: entry.expected } : {}),
      ...(entry.actual !== undefined ? { actual: entry.actual } : {}),
      ...(entry.passed !== undefined ? { passed: entry.passed } : {}),
      ...(entry.error !== undefined ? { error: entry.error } : {}),
    })),
    stdout: value.stdout ?? '',
    durationMs: value.durationMs ?? 0,
    ...(value.error !== undefined ? { error: value.error } : {}),
  };
}

function snapshot(value) {
  const state = states[value.state];
  if (!state) throw judgeError();
  return {
    jobId: value.jobId,
    problemId: value.problemId,
    problemVersion: value.problemVersion,
    state,
    createdAt: value.createdAt,
    ...(value.startedAt ? { startedAt: value.startedAt } : {}),
    ...(value.finishedAt ? { finishedAt: value.finishedAt } : {}),
    ...(value.result ? { result: result(value.result) } : {}),
    ...(value.error !== undefined ? { error: value.error } : {}),
    revision: String(value.revision),
  };
}

/** Resolve the current Sandbox session per operation, while keeping one grading API. */
export async function createJudgeAdapter({ address, token, hosted, client, resolveClient } = {}) {
  const direct =
    client ??
    (resolveClient
      ? undefined
      : (await import('./client.ts')).createJudgeClient(address, { token, hosted }));
  const transport = resolveClient ?? (() => direct);
  async function unary(method, request, timeoutMs, signal) {
    try {
      signal?.throwIfAborted();
      const connection = await transport({ signal });
      signal?.throwIfAborted();
      return await connection.service[method](request, { timeoutMs, signal });
    } catch (error) {
      throw judgeError(error);
    }
  }
  return {
    async run(request, { signal } = {}) {
      return result(await unary('run', request, 40_000, signal));
    },
    async submit(request) {
      // Acceptance survives browser disconnects; retries reuse the same UUID.
      return snapshot(await unary('submit', request, 10_000));
    },
    async getJob(jobId, { signal } = {}) {
      return snapshot(await unary('getJob', { jobId }, 5000, signal));
    },
    async listJobs(request, { signal } = {}) {
      const response = await unary('listJobs', request, 5000, signal);
      return { jobs: response.jobs.map(snapshot), nextPageToken: response.nextPageToken ?? '' };
    },
    async cancelJob(jobId) {
      return snapshot(await unary('cancelJob', { jobId }, 10_000));
    },
    watchJob(jobId, { signal } = {}) {
      const abort = new AbortController();
      const encoder = new TextEncoder();
      let controller, heartbeat, rotation, resume;
      let closed = false;
      const stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        clearTimeout(rotation);
        signal?.removeEventListener('abort', finish);
        abort.abort();
        resume?.();
      };
      const finish = () => {
        if (closed) return;
        stop();
        controller.close();
      };
      const send = (event, value) => {
        if (!closed)
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`));
      };
      async function observe() {
        try {
          const connection = await transport({ signal: abort.signal });
          if (closed) return;
          for await (const value of connection.service.watchJob(
            { jobId },
            { timeoutMs: 70_000, signal: abort.signal },
          )) {
            if (closed) break;
            send('snapshot', snapshot(value));
            if (controller.desiredSize <= 0)
              await new Promise((resolve) => {
                resume = resolve;
              });
          }
          finish();
        } catch (cause) {
          if (closed) return;
          const error = judgeError(cause);
          send('unavailable', { error: error.message, code: error.code });
          finish();
        }
      }
      return new ReadableStream({
        start(stream) {
          controller = stream;
          if (signal?.aborted) return finish();
          signal?.addEventListener('abort', finish, { once: true });
          heartbeat = setInterval(() => {
            if (!closed && controller.desiredSize > 0)
              controller.enqueue(encoder.encode(': keepalive\n\n'));
          }, 15_000);
          heartbeat.unref?.();
          // A planned rotation keeps healthy observations within Function duration.
          rotation = setTimeout(() => {
            send('reconnect', {});
            finish();
          }, 60_000);
          rotation.unref?.();
          void observe();
        },
        pull() {
          resume?.();
          resume = undefined;
        },
        cancel: stop,
      });
    },
    close() {
      direct?.close();
    },
  };
}
