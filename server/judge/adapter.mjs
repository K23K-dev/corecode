import { status } from '@grpc/grpc-js';
import { RequestError } from '../validation.mjs';

const states = Object.fromEntries(
  ['queued', 'running', 'canceling', 'completed', 'failed', 'canceled'].map((state) => [
    `JOB_STATE_${state.toUpperCase()}`,
    state,
  ]),
);

function judgeError(error) {
  if (error instanceof RequestError) return error;
  const mapped = {
    [status.INVALID_ARGUMENT]: [400, 'invalid_request', 'The execution request is invalid.'],
    [status.NOT_FOUND]: [404, 'not_found', 'The problem or submission was not found.'],
    [status.ALREADY_EXISTS]: [
      409,
      'submission_conflict',
      'That submission ID belongs to different input. Check its saved result before retrying.',
    ],
    [status.FAILED_PRECONDITION]: [
      409,
      'problem_changed',
      'The problem or grading setup changed. Refresh before trying again.',
    ],
    [status.RESOURCE_EXHAUSTED]: [
      429,
      'runner_busy',
      'Execution slots are busy or submissions are waiting. Try again shortly.',
    ],
    [status.CANCELLED]: [499, 'canceled', 'The execution request was canceled.'],
    [status.DEADLINE_EXCEEDED]: [
      504,
      'judge_timeout',
      'The judge did not respond in time. Check the submission status before retrying.',
    ],
  }[error?.code] ?? [
    503,
    'judge_unavailable',
    'The local judge is unavailable. Start it and try again.',
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

/** A shared local transport. Hosted execution never creates this adapter. */
export async function createJudgeAdapter({ address, client } = {}) {
  const transport = client ?? (await import('./client.ts')).createJudgeClient(address);
  const service = transport.service;
  function unary(method, request, timeout, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(judgeError({ code: status.CANCELLED }));
      let call,
        finished = false;
      const cancel = () => call?.cancel();
      try {
        call = service[method](request, { deadline: Date.now() + timeout }, (error, value) => {
          finished = true;
          signal?.removeEventListener('abort', cancel);
          if (error) reject(judgeError(error));
          else if (!value) reject(judgeError());
          else resolve(value);
        });
      } catch (error) {
        reject(judgeError(error));
        return;
      }
      if (!finished) {
        signal?.addEventListener('abort', cancel, { once: true });
        if (signal?.aborted) cancel();
      }
    });
  }

  return {
    async run(request, { signal } = {}) {
      return result(await unary('run', request, 40_000, signal));
    },
    async submit(request) {
      // Once dispatched, acceptance survives browser disconnects. The same UUID
      // lets the browser resolve a lost response without creating another job.
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
      let call, controller, heartbeat;
      let closed = false;
      const encoder = new TextEncoder();
      const stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        signal?.removeEventListener('abort', finish);
        call?.cancel();
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
      const fail = (cause) => {
        if (closed) return;
        const error = judgeError(cause);
        send('unavailable', { error: error.message, code: error.code });
        finish();
      };
      return new ReadableStream({
        start(stream) {
          controller = stream;
          if (signal?.aborted) return finish();
          signal?.addEventListener('abort', finish, { once: true });
          try {
            call = service.watchJob({ jobId }, { deadline: Date.now() + 5 * 60_000 });
            call.on('data', (value) => {
              if (closed) return;
              try {
                send('snapshot', snapshot(value));
                if (controller.desiredSize <= 0) call.pause();
              } catch (error) {
                fail(error);
              }
            });
            call.on('error', fail);
            call.on('end', finish);
            heartbeat = setInterval(() => {
              if (!closed && controller.desiredSize > 0)
                controller.enqueue(encoder.encode(': keepalive\n\n'));
            }, 15_000);
            heartbeat.unref?.();
          } catch (error) {
            fail(error);
          }
        },
        pull() {
          call?.resume();
        },
        cancel() {
          stop();
        },
      });
    },
    close() {
      transport.close();
    },
  };
}
