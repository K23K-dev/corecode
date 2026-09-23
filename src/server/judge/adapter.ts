import { Code, type CallOptions } from '@connectrpc/connect';
import { RequestError } from '../validation.ts';
import type { JudgeClient } from './client.ts';
import type { JobSnapshot, RunResult } from './gen/judge_pb.ts';

const states = ['', 'queued', 'running', 'canceling', 'completed', 'failed', 'canceled'] as const;
type SignalOptions = { signal?: AbortSignal };
export type JudgeClientResolver = (options?: SignalOptions) => JudgeClient | Promise<JudgeClient>;
export type JudgeAdapter = Awaited<ReturnType<typeof createJudgeAdapter>>;

function judgeError(error?: unknown) {
  if (error instanceof RequestError) return error;
  const cause = error !== null && typeof error === 'object' ? error : {};
  const code =
    'name' in cause && cause.name === 'AbortError'
      ? Code.Canceled
      : 'code' in cause && typeof cause.code === 'number'
        ? cause.code
        : Code.Unknown;
  const errors: Partial<Record<number, [number, string, string]>> = {
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
  };
  const mapped: [number, string, string] = errors[code] ?? [
    503,
    'judge_unavailable',
    'The judge is unavailable. Try again shortly or check its server configuration.',
  ];
  return new RequestError(mapped[2], mapped[0], mapped[1]);
}

function result(value: RunResult) {
  return {
    cases: value.cases.map((entry) => ({
      name: entry.name,
      input: entry.input,
      expected: entry.expected,
      actual: entry.actual,
      passed: entry.passed,
      error: entry.error,
    })),
    stdout: value.stdout,
    durationMs: value.durationMs,
    error: value.error,
  };
}

function snapshot(value: JobSnapshot) {
  const state = states[value.state];
  if (!state) throw judgeError();
  return {
    jobId: value.jobId,
    problemId: value.problemId,
    problemVersion: value.problemVersion,
    state,
    createdAt: value.createdAt,
    startedAt: value.startedAt || undefined,
    finishedAt: value.finishedAt || undefined,
    result: value.result ? result(value.result) : undefined,
    error: value.error,
    revision: String(value.revision),
  };
}

/** Resolve the current Sandbox session per operation, while keeping one grading API. */
export async function createJudgeAdapter({
  address,
  token,
  hosted,
  client,
  resolveClient,
}: {
  address?: string;
  token?: string;
  hosted?: boolean;
  client?: JudgeClient;
  resolveClient?: JudgeClientResolver;
} = {}) {
  const direct =
    client ??
    (resolveClient
      ? undefined
      : (await import('./client.ts')).createJudgeClient(address, { token, hosted }));
  const transport: JudgeClientResolver = resolveClient ?? (() => direct!);
  async function unary<T>(
    invoke: (client: JudgeClient, options: CallOptions) => Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      signal?.throwIfAborted();
      const connection = await transport({ signal });
      signal?.throwIfAborted();
      return await invoke(connection, { timeoutMs, signal });
    } catch (error) {
      throw judgeError(error);
    }
  }
  return {
    async run(
      request: Parameters<JudgeClient['service']['run']>[0],
      { signal }: SignalOptions = {},
    ) {
      return result(
        await unary((client, options) => client.service.run(request, options), 40_000, signal),
      );
    },
    async submit(request: Parameters<JudgeClient['service']['submit']>[0]) {
      // Acceptance survives browser disconnects; retries reuse the same UUID.
      return snapshot(
        await unary((client, options) => client.service.submit(request, options), 10_000),
      );
    },
    async getJob(jobId: string, { signal }: SignalOptions = {}) {
      return snapshot(
        await unary((client, options) => client.service.getJob({ jobId }, options), 5000, signal),
      );
    },
    async listJobs(
      request: Parameters<JudgeClient['service']['listJobs']>[0],
      { signal }: SignalOptions = {},
    ) {
      const response = await unary(
        (client, options) => client.service.listJobs(request, options),
        5000,
        signal,
      );
      return { jobs: response.jobs.map(snapshot), nextPageToken: response.nextPageToken };
    },
    async cancelJob(jobId: string) {
      return snapshot(
        await unary((client, options) => client.service.cancelJob({ jobId }, options), 10_000),
      );
    },
    watchJob(jobId: string, { signal }: SignalOptions = {}) {
      const abort = new AbortController();
      const encoder = new TextEncoder();
      let controller: ReadableStreamDefaultController<Uint8Array>;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      let rotation: ReturnType<typeof setTimeout> | undefined;
      let resume: (() => void) | undefined;
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
      const send = (event: string, value: unknown) => {
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
            if ((controller.desiredSize ?? 0) <= 0)
              await new Promise<void>((resolve) => {
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
      return new ReadableStream<Uint8Array>({
        start(stream) {
          controller = stream;
          if (signal?.aborted) return finish();
          signal?.addEventListener('abort', finish, { once: true });
          heartbeat = setInterval(() => {
            if (!closed && (controller.desiredSize ?? 0) > 0)
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
