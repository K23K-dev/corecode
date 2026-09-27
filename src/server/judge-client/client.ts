import 'server-only';
import { Agent } from 'node:https';
import { Code, createClient, type CallOptions, type Interceptor } from '@connectrpc/connect';
import { createGrpcWebTransport } from '@connectrpc/connect-node';
import { RequestError } from '../middleware';
import { JudgeService, type JobSnapshot, type RunResult } from './gen/judge_pb';
import { Health, HealthCheckResponse_ServingStatus } from './gen/grpc/health/v1/health_pb';

export type JudgeClient = ReturnType<typeof createJudgeClient>;
export type JudgeClientResolver = (options?: {
  signal?: AbortSignal;
}) => JudgeClient | Promise<JudgeClient>;
export type Judge = ReturnType<typeof createJudge>;
type SignalOptions = { signal?: AbortSignal };

/** gRPC-Web over HTTPS: the Sandbox's endpoint proxies HTTP/1.1 to the judge. */
export function createJudgeClient(address: string, token: string) {
  const url = new URL(address);
  if (url.protocol !== 'https:') throw new Error('The judge token may only be sent over HTTPS.');
  const authorize: Interceptor = (next) => (request) => {
    request.header.set('authorization', `Bearer ${token}`);
    return next(request);
  };
  const options = {
    baseUrl: url.origin,
    readMaxBytes: 1024 * 1024,
    writeMaxBytes: 1024 * 1024,
    interceptors: [authorize],
  };
  const agent = new Agent({ keepAlive: true });
  const transport = createGrpcWebTransport({
    ...options,
    httpVersion: '1.1',
    nodeOptions: { agent },
  });
  const health = createClient(Health, transport);
  return {
    service: createClient(JudgeService, transport),
    async checkHealth() {
      const response = await health.check({ service: '' }, { timeoutMs: 2000 });
      return HealthCheckResponse_ServingStatus[response.status];
    },
    close() {
      agent.destroy();
    },
  };
}

const JOB_STATES = [
  '',
  'queued',
  'running',
  'canceling',
  'completed',
  'failed',
  'canceled',
] as const;

/** gRPC status → [HTTP status, API error code, message]; anything else is 503. */
const JUDGE_ERRORS: Partial<Record<Code, [number, string, string]>> = {
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

function judgeError(error?: unknown) {
  if (error instanceof RequestError) return error;
  const cause = error !== null && typeof error === 'object' ? error : {};
  const code =
    'name' in cause && cause.name === 'AbortError'
      ? Code.Canceled
      : 'code' in cause && typeof cause.code === 'number'
        ? cause.code
        : Code.Unknown;
  const [status, errorCode, message] = JUDGE_ERRORS[code as Code] ?? [
    503,
    'judge_unavailable',
    'The judge is unavailable. Try again shortly or check its server configuration.',
  ];
  return new RequestError(message, status, errorCode);
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
  const state = JOB_STATES[value.state];
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

/** The judge operations the API uses; `resolve` supplies a ready client for each call. */
export function createJudge(resolve: JudgeClientResolver) {
  async function call<T>(
    invoke: (client: JudgeClient, options: CallOptions) => Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      signal?.throwIfAborted();
      const client = await resolve({ signal });
      signal?.throwIfAborted();
      return await invoke(client, { timeoutMs, signal });
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
        await call((client, options) => client.service.run(request, options), 40_000, signal),
      );
    },
    async submit(request: Parameters<JudgeClient['service']['submit']>[0]) {
      // Acceptance survives browser disconnects; retries reuse the same UUID.
      return snapshot(
        await call((client, options) => client.service.submit(request, options), 10_000),
      );
    },
    async getJob(jobId: string, { signal }: SignalOptions = {}) {
      return snapshot(
        await call((client, options) => client.service.getJob({ jobId }, options), 5000, signal),
      );
    },
    async recoverJob(problemId: string, { signal }: SignalOptions = {}) {
      const response = await call(
        (client, options) => client.service.listJobs({ problemId }, options),
        5000,
        signal,
      );
      return response.jobs[0] ? snapshot(response.jobs[0]) : null;
    },
    async cancelJob(jobId: string) {
      return snapshot(
        await call((client, options) => client.service.cancelJob({ jobId }, options), 10_000),
      );
    },
  };
}
