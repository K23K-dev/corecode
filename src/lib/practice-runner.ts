import type { Exercise } from './exercises';

export type TestCase = {
  name: string;
  args: string;
  expected: string;
  check?: 'unchanged' | 'independent_rows';
};

export type CaseResult = {
  name: string;
  input: string;
  expected?: string;
  actual?: string;
  passed?: boolean;
  error?: string;
};

export type RunResult = {
  cases: CaseResult[];
  stdout: string;
  durationMs: number;
  error?: string;
};

export type JobSnapshot = {
  jobId: string;
  problemId: string;
  problemVersion: string;
  state: 'queued' | 'running' | 'canceling' | 'completed' | 'failed' | 'canceled';
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: RunResult;
  error?: string;
  revision: string;
};
export type ExecutionOutcome = {
  durable: boolean;
  result?: RunResult;
  job?: JobSnapshot;
  code?: string;
};
type OnJob = (job: JobSnapshot, code?: string) => void;
type PendingSubmission = {
  submissionId: string;
  problemId: string;
  problemVersion: string;
  code: string;
  completionIntentIds: string[];
  cancelRequested: boolean;
  createdAt: number;
};
type RecoveryStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
type Dependencies = {
  fetch?: typeof fetch;
  storage?: RecoveryStorage | null;
  EventSource?: typeof EventSource;
  id?: () => string;
};
const pendingPrefix = 'coding-practice:submission:postgres:v1:';
const pendingMemory = new Map<string, PendingSubmission>();
const terminal = (job: JobSnapshot) => ['completed', 'failed', 'canceled'].includes(job.state);

function browserStorage(): RecoveryStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function pendingSubmissions(storage: RecoveryStorage | null): PendingSubmission[] {
  const entries = new Map(pendingMemory);
  try {
    for (let i = 0; storage && i < storage.length; i++) {
      const key = storage.key(i);
      if (!key?.startsWith(pendingPrefix)) continue;
      const item = JSON.parse(storage.getItem(key) ?? 'null') as PendingSubmission | null;
      if (
        item &&
        key === pendingPrefix + item.submissionId &&
        typeof item.problemId === 'string' &&
        typeof item.problemVersion === 'string' &&
        typeof item.code === 'string' &&
        Array.isArray(item.completionIntentIds) &&
        item.completionIntentIds.every((id) => typeof id === 'string')
      )
        entries.set(item.submissionId, {
          ...item,
          cancelRequested:
            item.cancelRequested || entries.get(item.submissionId)?.cancelRequested || false,
        });
    }
  } catch {
    // Existing in-memory records remain recoverable if browser storage disappears.
  }
  return [...entries.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function pendingSubmissionProblemIds(): string[] {
  return [...new Set(pendingSubmissions(browserStorage()).map((item) => item.problemId))];
}

function jobSnapshot(value: unknown): JobSnapshot {
  const job = value as JobSnapshot | null;
  if (
    !job ||
    typeof job.jobId !== 'string' ||
    typeof job.problemId !== 'string' ||
    !['queued', 'running', 'canceling', 'completed', 'failed', 'canceled'].includes(job.state) ||
    typeof job.revision !== 'string' ||
    !/^\d+$/.test(job.revision)
  ) {
    throw new Error('Invalid submission response. Reopen this problem to reconnect.');
  }
  return job;
}

class RunnerRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Owns temporary requests and durable recovery; only an explicit Stop cancels a job. */
export class PracticeRunner {
  private readonly fetcher: typeof fetch;
  private readonly storage: RecoveryStorage | null;
  private readonly events: typeof EventSource;
  private readonly id: () => string;
  private controller: AbortController | null = null;
  private pending: PendingSubmission | null = null;
  private job: JobSnapshot | null = null;
  private receive: OnJob | null = null;
  private capability: 'durable' | 'synchronous' | null = null;

  constructor(dependencies: Dependencies = {}) {
    this.fetcher = dependencies.fetch ?? globalThis.fetch.bind(globalThis);
    this.storage = dependencies.storage === undefined ? browserStorage() : dependencies.storage;
    this.events = dependencies.EventSource ?? globalThis.EventSource;
    this.id = dependencies.id ?? (() => crypto.randomUUID());
  }

  private async json(url: string, signal: AbortSignal, body?: unknown, timeout = 15_000) {
    const response = await this.fetcher(url, {
      method: body === undefined ? 'GET' : 'POST',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
      headers: { 'Content-Type': 'application/json', 'X-Code-Practice-Client': '1' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error('The runner response was too large.');
    if (response.status === 401 || response.status === 403)
      throw new RunnerRequestError(
        'Open the website and sign in again before running code.',
        response.status,
      );
    if (!response.headers.get('content-type')?.includes('application/json'))
      throw new Error('The execution API is unavailable. Your code is still saved.');
    const value = JSON.parse(text);
    if (!response.ok)
      throw new RunnerRequestError(
        value.error ?? 'The runner is unavailable.',
        response.status,
        value.code,
      );
    return { value, status: response.status };
  }

  private async executionMode(signal: AbortSignal) {
    if (!this.capability) {
      const { value } = await this.json('/api/health', signal);
      if (value.executionMode !== 'durable' && value.executionMode !== 'synchronous')
        throw new Error('Refresh the website before running code.');
      this.capability = value.executionMode;
    }
    return this.capability;
  }

  private save(pending: PendingSubmission, required = false) {
    if (required && !this.storage)
      throw new Error('Browser recovery storage is unavailable. Enable it before submitting.');
    try {
      this.storage?.setItem(pendingPrefix + pending.submissionId, JSON.stringify(pending));
    } catch {
      if (required)
        throw new Error(
          'Your submission could not be saved for recovery. Free browser storage and retry.',
        );
    }
    pendingMemory.set(pending.submissionId, pending);
  }

  private forget(id: string) {
    pendingMemory.delete(id);
    try {
      this.storage?.removeItem(pendingPrefix + id);
    } catch {
      /* The server snapshot can clear it on recovery. */
    }
  }

  private begin() {
    this.detach();
    this.controller = new AbortController();
    return this.controller;
  }

  private done(controller: AbortController) {
    if (this.controller === controller) {
      this.controller = null;
      this.pending = null;
      this.job = null;
      this.receive = null;
    }
  }

  async run(
    exercise: Exercise,
    code: string,
    mode: 'example' | 'submit',
    options: { completionIntentIds?: string[]; onJob?: OnJob } = {},
  ): Promise<ExecutionOutcome> {
    const controller = this.begin();
    try {
      const executionMode = await this.executionMode(controller.signal);
      controller.signal.throwIfAborted();
      if (mode === 'submit' && executionMode === 'durable') {
        if (!exercise.version) throw new Error('Refresh this problem before submitting.');
        const existing = pendingSubmissions(this.storage).find(
          (item) => item.problemId === exercise.id && !item.cancelRequested,
        );
        const pending = existing ?? {
          submissionId: this.id(),
          problemId: exercise.id,
          problemVersion: exercise.version,
          code,
          completionIntentIds: [...(options.completionIntentIds ?? [])],
          cancelRequested: false,
          createdAt: Date.now(),
        };
        if (pending.completionIntentIds.length > 256)
          throw new Error('Save pending completion changes before submitting.');
        if (!existing) this.save(pending, true);
        return await this.submit(pending, controller.signal, options.onJob);
      }
      const { value, status } = await this.json(
        '/api/run',
        controller.signal,
        {
          problemId: exercise.id,
          problemVersion: exercise.version,
          code,
          mode,
        },
        executionMode === 'durable' ? 45_000 : 165_000,
      );
      if (status !== 200 || !Array.isArray(value.cases) || value.cases.length > 32)
        throw new Error('Invalid runner response.');
      return { durable: false, result: value as RunResult, code };
    } finally {
      this.done(controller);
    }
  }

  private async submit(
    pending: PendingSubmission,
    signal: AbortSignal,
    onJob?: OnJob,
  ): Promise<ExecutionOutcome> {
    this.pending = pending;
    let job: JobSnapshot;
    let accepting = false;
    try {
      if (pending.cancelRequested) {
        const { value } = await this.json(
          `/api/jobs/${encodeURIComponent(pending.submissionId)}/cancel`,
          signal,
          {},
        );
        job = jobSnapshot(value);
      } else {
        accepting = true;
        const { value, status } = await this.json('/api/run', signal, {
          problemId: pending.problemId,
          problemVersion: pending.problemVersion,
          code: pending.code,
          mode: 'submit',
          submissionId: pending.submissionId,
          completionIntentIds: pending.completionIntentIds,
        });
        accepting = false;
        if (status !== 202)
          throw new Error(
            'Submission acceptance was not confirmed. Reopen this problem to retry safely.',
          );
        job = jobSnapshot(value);
        if (pending.cancelRequested) {
          job = jobSnapshot(
            (await this.json(`/api/jobs/${encodeURIComponent(job.jobId)}/cancel`, signal, {}))
              .value,
          );
        }
      }
    } catch (error) {
      if (
        accepting &&
        error instanceof RunnerRequestError &&
        ([400, 404, 413, 422].includes(error.status) || error.code === 'problem_changed')
      ) {
        this.forget(pending.submissionId);
        throw error;
      }
      if (signal.aborted) throw error;
      if (pending.cancelRequested && error instanceof RunnerRequestError && error.status === 404)
        throw new RunnerRequestError(
          'Cancellation is still unconfirmed because this submission has not appeared on the server. Reopen this problem to check again.',
          404,
          'cancel_pending',
        );
      throw new Error(
        `${error instanceof Error ? error.message : 'The submission connection failed.'} Reopen this problem to reconnect using the same submission ID.`,
      );
    }
    if (job.jobId !== pending.submissionId || job.problemId !== pending.problemId)
      throw new Error('The submission response did not match your saved request.');
    return this.observe(job, signal, onJob, pending.code);
  }

  async recover(exercise: Exercise, onJob?: OnJob): Promise<ExecutionOutcome | null> {
    const controller = this.begin();
    try {
      if ((await this.executionMode(controller.signal)) !== 'durable') return null;
      controller.signal.throwIfAborted();
      let outcome: ExecutionOutcome | null = null;
      let unresolvedCancellation: Error | null = null;
      const pending = pendingSubmissions(this.storage).filter(
        (item) => item.problemId === exercise.id,
      );
      for (const item of pending) {
        try {
          outcome = await this.submit(item, controller.signal, onJob);
        } catch (error) {
          if (error instanceof RunnerRequestError && error.code === 'cancel_pending')
            unresolvedCancellation = error;
          else throw error;
        } finally {
          if (this.controller === controller) {
            this.pending = null;
            this.job = null;
            this.receive = null;
          }
        }
      }
      if (outcome) return outcome;
      const { value } = await this.json(
        `/api/jobs?problemId=${encodeURIComponent(exercise.id)}&pageSize=50`,
        controller.signal,
      );
      const jobs = (value.jobs as unknown[]).map(jobSnapshot);
      const recent = jobs.find((job) => !terminal(job)) ?? jobs[0];
      if (!recent) {
        if (unresolvedCancellation) throw unresolvedCancellation;
        return null;
      }
      const { value: full } = await this.json(
        `/api/jobs/${encodeURIComponent(recent.jobId)}`,
        controller.signal,
      );
      return await this.observe(jobSnapshot(full), controller.signal, onJob);
    } finally {
      this.done(controller);
    }
  }

  private async observe(
    initial: JobSnapshot,
    signal: AbortSignal,
    onJob?: OnJob,
    code?: string,
  ): Promise<ExecutionOutcome> {
    const job = await new Promise<JobSnapshot>((resolve, reject) => {
      let current = initial,
        source: EventSource | null = null;
      let timer: ReturnType<typeof setTimeout> | undefined,
        retries = 0,
        finished = false;
      const close = () => {
        source?.close();
        source = null;
        clearTimeout(timer);
      };
      const finish = (error?: Error) => {
        if (finished) return;
        finished = true;
        close();
        signal.removeEventListener('abort', abort);
        this.receive = null;
        if (error) reject(error);
        else resolve(current);
      };
      const abort = () => finish(new DOMException('Observation stopped.', 'AbortError'));
      const accept = (next: JobSnapshot) => {
        if (finished || signal.aborted || next.jobId !== initial.jobId) return;
        if (BigInt(next.revision) < BigInt(current.revision)) return;
        if (BigInt(next.revision) > BigInt(current.revision)) retries = 0;
        current = next;
        this.job = next;
        onJob?.(next, code);
        if (terminal(next)) finish();
      };
      const reconnect = (message = 'The submission connection was interrupted.') => {
        close();
        if (finished || signal.aborted) return;
        if (++retries > 5) {
          finish(
            new Error(`${message} Reopen this problem to reconnect; your submission stays saved.`),
          );
          return;
        }
        timer = setTimeout(
          async () => {
            try {
              const { value } = await this.json(
                `/api/jobs/${encodeURIComponent(initial.jobId)}`,
                signal,
              );
              accept(jobSnapshot(value));
              if (!finished) connect();
            } catch (error) {
              reconnect(error instanceof Error ? error.message : message);
            }
          },
          Math.min(1000 * 2 ** (retries - 1), 8000),
        );
      };
      const connect = () => {
        const stream = new this.events(`/api/jobs/${encodeURIComponent(initial.jobId)}/events`);
        source = stream;
        stream.addEventListener('snapshot', (event) => {
          if (source !== stream) return;
          try {
            accept(jobSnapshot(JSON.parse((event as MessageEvent).data)));
          } catch {
            reconnect('The submission stream could not be read.');
          }
        });
        stream.addEventListener('unavailable', () => {
          if (source === stream) reconnect();
        });
        stream.onerror = () => {
          if (source === stream) reconnect();
        };
      };
      this.receive = accept;
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else {
        accept(initial);
        if (!finished) connect();
      }
    });
    this.forget(job.jobId);
    return { durable: true, job, result: job.result, code };
  }

  detach() {
    this.controller?.abort();
    this.controller = null;
    this.pending = null;
    this.job = null;
    this.receive = null;
  }

  async cancel(): Promise<JobSnapshot | void> {
    const pending = this.pending;
    if (pending) {
      pending.cancelRequested = true;
      this.save(pending);
    }
    const id = this.job?.jobId ?? pending?.submissionId;
    if (!id) {
      this.controller?.abort();
      return;
    }
    try {
      const { value } = await this.json(
        `/api/jobs/${encodeURIComponent(id)}/cancel`,
        new AbortController().signal,
        {},
      );
      const job = jobSnapshot(value);
      if (terminal(job)) this.forget(job.jobId);
      this.receive?.(job);
      return job;
    } catch (error) {
      // Acceptance can still be committing. submit() checks the saved flag again
      // after its response; recovery only cancels this UUID, never re-enqueues it.
      if (pending && !this.job && error instanceof RunnerRequestError && error.status === 404)
        throw new Error(
          'Cancellation is pending while submission acceptance is confirmed. Reopen this problem to reconnect.',
        );
      throw error;
    }
  }
}
