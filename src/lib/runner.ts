import type { Problem } from '../schemas/catalog';
import {
  JobSnapshotSchema,
  PendingSubmissionSchema,
  RunResultSchema,
  type JobSnapshot,
  type RunResult,
  type PendingSubmission,
} from '../schemas/submissions';
import { ApiError, requestJson } from './api';
export type { CaseResult, RunResult, JobSnapshot } from '../schemas/submissions';

export type ExecutionOutcome = {
  result?: RunResult;
  job?: JobSnapshot;
  code?: string;
};
type OnJob = (job: JobSnapshot, code?: string) => void;
type RecoveryStorage = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;
type Dependencies = {
  fetch?: typeof fetch;
  storage?: RecoveryStorage | null;
  id?: () => string;
};
const terminal = (job: JobSnapshot) => ['completed', 'failed', 'canceled'].includes(job.state);

function jobSnapshot(value: unknown): JobSnapshot {
  const parsed = JobSnapshotSchema.safeParse(value);
  if (!parsed.success)
    throw new Error('Invalid submission response. Reopen this problem to reconnect.');
  return parsed.data;
}

/** Resolve after `ms`, or as soon as `signal` aborts. */
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

// Pending submissions are saved before sending, so a reload or another page can
// reconnect with the same UUID. Memory keeps them if browser storage fails.
const PENDING_PREFIX = 'coding-practice:submission:postgres:v1:';
const pendingMemory = new Map<string, PendingSubmission>();

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
      if (!key?.startsWith(PENDING_PREFIX)) continue;
      try {
        const parsed = PendingSubmissionSchema.safeParse(
          JSON.parse(storage.getItem(key) ?? 'null'),
        );
        if (!parsed.success) continue;
        const item = parsed.data;
        if (key === PENDING_PREFIX + item.submissionId)
          entries.set(item.submissionId, {
            ...item,
            cancelRequested:
              item.cancelRequested || entries.get(item.submissionId)?.cancelRequested || false,
          });
      } catch {
        // Leave unreadable records untouched and recover the remaining submissions.
      }
    }
  } catch {
    // Existing in-memory records remain recoverable if browser storage disappears.
  }
  return [...entries.values()].sort((a, b) => a.createdAt - b.createdAt);
}

function savePending(
  storage: RecoveryStorage | null,
  pending: PendingSubmission,
  required = false,
) {
  if (required && !storage)
    throw new Error('Browser recovery storage is unavailable. Enable it before submitting.');
  try {
    storage?.setItem(PENDING_PREFIX + pending.submissionId, JSON.stringify(pending));
  } catch {
    if (required)
      throw new Error(
        'Your submission could not be saved for recovery. Free browser storage and retry.',
      );
  }
  pendingMemory.set(pending.submissionId, pending);
}

function forgetPending(storage: RecoveryStorage | null, id: string) {
  pendingMemory.delete(id);
  try {
    storage?.removeItem(PENDING_PREFIX + id);
  } catch {
    // The server snapshot can clear it on recovery.
  }
}

export function pendingSubmissionProblemIds(): string[] {
  return [...new Set(pendingSubmissions(browserStorage()).map((item) => item.problemId))];
}

/** Owns temporary requests and durable recovery; only an explicit Stop cancels a job. */
export class Runner {
  private readonly fetcher: typeof fetch;
  private readonly storage: RecoveryStorage | null;
  private readonly id: () => string;
  // The active run or observation: its abort controller, the submission being sent,
  // its latest snapshot, and where cancel() delivers the Stop response.
  private controller: AbortController | null = null;
  private pending: PendingSubmission | null = null;
  private job: JobSnapshot | null = null;
  private receive: OnJob | null = null;

  constructor(dependencies: Dependencies = {}) {
    this.fetcher = dependencies.fetch ?? fetch;
    this.storage = dependencies.storage === undefined ? browserStorage() : dependencies.storage;
    this.id = dependencies.id ?? (() => crypto.randomUUID());
  }

  /** Execution requests may wait for the hosted judge to wake, so they allow two minutes. */
  private call(path: string, signal: AbortSignal, body?: unknown, timeoutMs = 120_000) {
    return requestJson(path, { fetch: this.fetcher, signal, body, timeoutMs });
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
    problem: Problem,
    code: string,
    mode: 'example' | 'submit',
    onJob?: OnJob,
  ): Promise<ExecutionOutcome> {
    const controller = this.begin();
    try {
      controller.signal.throwIfAborted();
      if (mode === 'submit') {
        const existing = pendingSubmissions(this.storage).find(
          (item) => item.problemId === problem.id && !item.cancelRequested,
        );
        const pending = existing ?? {
          submissionId: this.id(),
          problemId: problem.id,
          problemVersion: problem.version,
          code,
          cancelRequested: false,
          createdAt: Date.now(),
        };
        if (!existing) savePending(this.storage, pending, true);
        return await this.submit(pending, controller.signal, onJob);
      }
      const { value, status } = await this.call(
        '/api/run',
        controller.signal,
        {
          problemId: problem.id,
          problemVersion: problem.version,
          code,
          mode,
        },
        140_000,
      );
      if (status !== 200) throw new Error('Invalid runner response.');
      return { result: RunResultSchema.parse(value), code };
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
        const { value } = await this.call(
          `/api/jobs/${encodeURIComponent(pending.submissionId)}/cancel`,
          signal,
          {},
        );
        job = jobSnapshot(value);
      } else {
        accepting = true;
        const { value, status } = await this.call('/api/run', signal, {
          problemId: pending.problemId,
          problemVersion: pending.problemVersion,
          code: pending.code,
          mode: 'submit',
          submissionId: pending.submissionId,
        });
        accepting = false;
        if (status !== 202)
          throw new Error(
            'Submission acceptance was not confirmed. Reopen this problem to retry safely.',
          );
        job = jobSnapshot(value);
        if (pending.cancelRequested) {
          job = jobSnapshot(
            (await this.call(`/api/jobs/${encodeURIComponent(job.jobId)}/cancel`, signal, {}))
              .value,
          );
        }
      }
    } catch (error) {
      // These rejections are final: the problem changed or the input can never be accepted.
      if (
        accepting &&
        error instanceof ApiError &&
        [400, 404, 409, 413, 422].includes(error.status)
      ) {
        forgetPending(this.storage, pending.submissionId);
        throw error;
      }
      if (signal.aborted) throw error;
      if (pending.cancelRequested && error instanceof ApiError && error.status === 404)
        throw new ApiError(
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

  async recover(problem: Problem, onJob?: OnJob): Promise<ExecutionOutcome | null> {
    const controller = this.begin();
    try {
      controller.signal.throwIfAborted();
      let outcome: ExecutionOutcome | null = null;
      let unresolvedCancellation: Error | null = null;
      const pending = pendingSubmissions(this.storage).filter(
        (item) => item.problemId === problem.id,
      );
      for (const item of pending) {
        try {
          outcome = await this.submit(item, controller.signal, onJob);
        } catch (error) {
          if (error instanceof ApiError && error.code === 'cancel_pending')
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
      const { value } = await this.call(
        `/api/jobs?problemId=${encodeURIComponent(problem.id)}`,
        controller.signal,
      );
      const recovered = (value as { job?: unknown }).job;
      if (recovered === null) {
        if (unresolvedCancellation) throw unresolvedCancellation;
        return null;
      }
      const job = jobSnapshot(recovered);
      if (job.problemId !== problem.id)
        throw new Error('The recovered submission belongs to another problem.');
      return await this.observe(job, controller.signal, onJob);
    } finally {
      this.done(controller);
    }
  }

  /** Poll once a second until the job finishes; a Stop response prompts an immediate poll. */
  private async observe(
    initial: JobSnapshot,
    signal: AbortSignal,
    onJob?: OnJob,
    code?: string,
  ): Promise<ExecutionOutcome> {
    const stopped = () => new DOMException('Observation stopped.', 'AbortError');
    let current = initial;
    let finished = false;
    let interrupt = new AbortController();
    const accept = (next: JobSnapshot) => {
      if (finished || signal.aborted) return;
      if (next.jobId !== initial.jobId || next.problemId !== initial.problemId)
        throw new Error('The submission response belongs to another job.');
      if (BigInt(next.revision) < BigInt(current.revision)) return;
      current = next;
      this.job = next;
      onJob?.(next, code);
    };
    // cancel() delivers its response here, interrupting an older GET or retry delay.
    const receive = (next: JobSnapshot) => {
      accept(next);
      interrupt.abort();
    };
    this.receive = receive;
    try {
      if (signal.aborted) throw stopped();
      accept(initial);
      let failures = 0;
      let delay = 1000;
      while (!terminal(current)) {
        await pause(delay, AbortSignal.any([signal, interrupt.signal]));
        if (signal.aborted) throw stopped();
        if (terminal(current)) break;
        if (interrupt.signal.aborted) interrupt = new AbortController();
        try {
          const { value } = await this.call(
            `/api/jobs/${encodeURIComponent(initial.jobId)}`,
            AbortSignal.any([signal, interrupt.signal]),
          );
          accept(jobSnapshot(value));
          failures = 0;
          delay = 1000;
        } catch {
          if (signal.aborted) throw stopped();
          if (interrupt.signal.aborted) delay = 0;
          else if (++failures > 5)
            throw new Error(
              'Submission status is unavailable. Reopen this problem to reconnect; your submission stays saved.',
            );
          else delay = Math.min(1000 * 2 ** (failures - 1), 8000);
        }
      }
    } finally {
      finished = true;
      if (this.receive === receive) this.receive = null;
    }
    forgetPending(this.storage, current.jobId);
    return { job: current, result: current.result, code };
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
      savePending(this.storage, pending);
    }
    const id = this.job?.jobId ?? pending?.submissionId;
    if (!id) {
      this.controller?.abort();
      return;
    }
    try {
      const { value } = await this.call(
        `/api/jobs/${encodeURIComponent(id)}/cancel`,
        new AbortController().signal,
        {},
      );
      const job = jobSnapshot(value);
      if (terminal(job)) forgetPending(this.storage, job.jobId);
      this.receive?.(job);
      return job;
    } catch (error) {
      // Acceptance can still be committing. submit() checks the saved flag again
      // after its response; recovery only cancels this UUID, never re-enqueues it.
      if (pending && !this.job && error instanceof ApiError && error.status === 404)
        throw new Error(
          'Cancellation is pending while submission acceptance is confirmed. Reopen this problem to reconnect.',
        );
      throw error;
    }
  }
}
