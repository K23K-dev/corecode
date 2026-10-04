import 'server-only';
import {
  Code,
  createClient,
  type CallOptions,
  type Client,
  type Interceptor,
} from '@connectrpc/connect';
import { createGrpcTransport } from '@connectrpc/connect-node';
import { RequestError } from '../middleware';
import { JudgeService, type JobSnapshot, type RunResult } from './gen/judge_pb';

type JudgeClient = Client<typeof JudgeService>;
type SignalOptions = { signal?: AbortSignal };

// gRPC over HTTP/2 to the judge's VM, where Caddy terminates HTTPS.
function createJudgeClient(address: string, token: string): JudgeClient {
  const url = new URL(address);
  // The token travels only over HTTPS, or plain HTTP on this machine (an SSH tunnel).
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('JUDGE_URL must use https:// (http:// only for this machine).');
  }
  const authorize: Interceptor = (next) => (request) => {
    request.header.set('authorization', `Bearer ${token}`);
    return next(request);
  };
  const transport = createGrpcTransport({
    baseUrl: url.origin,
    readMaxBytes: 1024 * 1024,
    writeMaxBytes: 1024 * 1024,
    interceptors: [authorize],
    // A Vercel Function can freeze between requests, so a connection idle for 10 s gets a
    // PING before reuse.
    pingIntervalMs: 10_000,
    pingTimeoutMs: 3000,
  });
  return createClient(JudgeService, transport);
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

// gRPC status → [HTTP status, API error code, message]; anything else is 503.
const JUDGE_ERRORS: Partial<Record<Code, [number, string, string]>> = {
  [Code.InvalidArgument]: [400, 'invalid_request', 'The execution request is invalid.'],
  [Code.NotFound]: [404, 'not_found', 'The problem or submission was not found.'],
  [Code.AlreadyExists]: [
    409,
    'submission_conflict',
    'That submission ID was already used for different input.',
  ],
  [Code.FailedPrecondition]: [
    409,
    'problem_changed',
    'The problem or grading setup changed. Refresh before trying again.',
  ],
  [Code.ResourceExhausted]: [
    429,
    'runner_busy',
    'Both execution slots are busy. Try again shortly.',
  ],
  [Code.Canceled]: [499, 'canceled', 'The execution request was canceled.'],
  [Code.DeadlineExceeded]: [504, 'judge_timeout', 'The judge did not respond in time.'],
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
    state,
    result: value.result ? result(value.result) : undefined,
    error: value.error,
    revision: String(value.revision),
  };
}

// The judge operations the API uses, with a timeout on each call.
export function createJudge(address: string, token: string) {
  const client = createJudgeClient(address, token);
  async function call<T>(
    invoke: (options: CallOptions) => Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    try {
      signal?.throwIfAborted();
      return await invoke({ timeoutMs, signal });
    } catch (error) {
      throw judgeError(error);
    }
  }
  return {
    async run(request: Parameters<JudgeClient['run']>[0], { signal }: SignalOptions = {}) {
      return result(await call((options) => client.run(request, options), 40_000, signal));
    },
    async submit(request: Parameters<JudgeClient['submit']>[0]) {
      // Acceptance survives browser disconnects; retries reuse the same UUID.
      return snapshot(await call((options) => client.submit(request, options), 10_000));
    },
    async getJob(jobId: string, { signal }: SignalOptions = {}) {
      return snapshot(await call((options) => client.getJob({ jobId }, options), 5000, signal));
    },
    async cancelJob(jobId: string) {
      return snapshot(await call((options) => client.cancelJob({ jobId }, options), 10_000));
    },
  };
}
