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
export type { RunResult, JobSnapshot } from '../schemas/submissions';

export type ExecutionOutcome = {
  result?: RunResult;
  job?: JobSnapshot;
  code?: string;
};
type OnJob = (job: JobSnapshot, code?: string) => void;
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

// Pending submissions are saved in the browser before sending, so a reload reconnects
// with the same UUID and the server records the submission only once.
const PENDING_PREFIX = 'coding-practice:submission:postgres:v1:';

function pendingSubmissions(): PendingSubmission[] {
  const found: PendingSubmission[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith(PENDING_PREFIX)) continue;
      try {
        const parsed = PendingSubmissionSchema.safeParse(
          JSON.parse(localStorage.getItem(key) ?? 'null'),
        );
        if (parsed.success && key === PENDING_PREFIX + parsed.data.submissionId)
          found.push(parsed.data);
      } catch {
        // Skip an unreadable record and recover the others.
      }
    }
  } catch {
    // Browser storage is unavailable, so nothing was saved to recover.
  }
  return found.sort((a, b) => a.createdAt - b.createdAt);
}

function savePending(pending: PendingSubmission) {
  try {
    localStorage.setItem(PENDING_PREFIX + pending.submissionId, JSON.stringify(pending));
  } catch {
    throw new Error(
      'Your submission could not be saved for recovery. Enable or free browser storage and retry.',
    );
  }
}

function forgetPending(id: string) {
  try {
    localStorage.removeItem(PENDING_PREFIX + id);
  } catch {
    // The next recovery finds the finished job and removes the record then.
  }
}

/** Owns temporary requests and durable recovery; only an explicit Stop cancels a job. */
export class Runner {
  // The active run or observation: its abort controller, the submission being sent,
  // its latest snapshot, and where cancel() delivers the Stop response.
  private controller: AbortController | null = null;
  private pending: PendingSubmission | null = null;
  private job: JobSnapshot | null = null;
  private receive: OnJob | null = null;

  /** Judge calls outlast autosave's timeout: a submission can wait in the queue first. */
  private call(path: string, signal: AbortSignal, body?: unknown, timeoutMs = 30_000) {
    return requestJson(path, { signal, body, timeoutMs });
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
        const existing = pendingSubmissions().find((item) => item.problemId === problem.id);
        const pending = existing ?? {
          submissionId: crypto.randomUUID(),
          problemId: problem.id,
          problemVersion: problem.version,
          code,
          createdAt: Date.now(),
        };
        if (!existing) savePending(pending);
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
        60_000,
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
    try {
      const { value, status } = await this.call('/api/run', signal, {
        problemId: pending.problemId,
        problemVersion: pending.problemVersion,
        code: pending.code,
        mode: 'submit',
        submissionId: pending.submissionId,
      });
      if (status !== 202)
        throw new Error(
          'Submission acceptance was not confirmed. Reopen this problem to retry safely.',
        );
      job = jobSnapshot(value);
    } catch (error) {
      // These rejections are final: the problem changed or the input can never be accepted.
      if (error instanceof ApiError && [400, 404, 409, 413, 422].includes(error.status)) {
        forgetPending(pending.submissionId);
        throw error;
      }
      if (signal.aborted) throw error;
      throw new Error(
        `${error instanceof Error ? error.message : 'The submission connection failed.'} Reopen this problem to reconnect.`,
      );
    }
    if (job.jobId !== pending.submissionId || job.problemId !== pending.problemId)
      throw new Error('The submission response did not match your saved request.');
    return this.observe(job, signal, onJob, pending.code);
  }

  /** Reconnects to this problem's submissions saved in the browser, resending the same UUIDs. */
  async recover(problem: Problem, onJob?: OnJob): Promise<ExecutionOutcome | null> {
    const controller = this.begin();
    try {
      let outcome: ExecutionOutcome | null = null;
      for (const item of pendingSubmissions().filter((item) => item.problemId === problem.id)) {
        try {
          outcome = await this.submit(item, controller.signal, onJob);
        } finally {
          if (this.controller === controller) {
            this.pending = null;
            this.job = null;
            this.receive = null;
          }
        }
      }
      return outcome;
    } finally {
      this.done(controller);
    }
  }

  /** Poll once a second until the job finishes, backing off while its status is unavailable. */
  private async observe(
    initial: JobSnapshot,
    signal: AbortSignal,
    onJob?: OnJob,
    code?: string,
  ): Promise<ExecutionOutcome> {
    const stopped = () => new DOMException('Observation stopped.', 'AbortError');
    let current = initial;
    let finished = false;
    // Polls and the Stop response can arrive out of order, so keep the newest revision.
    const accept = (next: JobSnapshot) => {
      if (finished || signal.aborted) return;
      if (next.jobId !== initial.jobId || next.problemId !== initial.problemId)
        throw new Error('The submission response belongs to another job.');
      if (BigInt(next.revision) < BigInt(current.revision)) return;
      current = next;
      this.job = next;
      onJob?.(next, code);
    };
    this.receive = accept;
    try {
      if (signal.aborted) throw stopped();
      accept(initial);
      let failures = 0;
      while (!terminal(current)) {
        await pause(failures ? Math.min(1000 * 2 ** (failures - 1), 8000) : 1000, signal);
        if (signal.aborted) throw stopped();
        if (terminal(current)) break;
        try {
          const { value } = await this.call(
            `/api/jobs/${encodeURIComponent(initial.jobId)}`,
            signal,
          );
          accept(jobSnapshot(value));
          failures = 0;
        } catch {
          if (signal.aborted) throw stopped();
          if (++failures > 5)
            throw new Error(
              'Submission status is unavailable. Reopen this problem to reconnect; your submission stays saved.',
            );
        }
      }
    } finally {
      finished = true;
      if (this.receive === accept) this.receive = null;
    }
    forgetPending(current.jobId);
    return { job: current, result: current.result, code };
  }

  detach() {
    this.controller?.abort();
    this.controller = null;
    this.pending = null;
    this.job = null;
    this.receive = null;
  }

  /** Stop: abandon a Run or a submission the judge hasn't confirmed; cancel a confirmed one. */
  async cancel(): Promise<JobSnapshot | void> {
    const id = this.job?.jobId;
    if (!id) {
      if (this.pending) forgetPending(this.pending.submissionId);
      this.controller?.abort();
      return;
    }
    const { value } = await this.call(
      `/api/jobs/${encodeURIComponent(id)}/cancel`,
      new AbortController().signal,
      {},
    );
    const job = jobSnapshot(value);
    if (terminal(job)) forgetPending(job.jobId);
    this.receive?.(job);
    return job;
  }
}
