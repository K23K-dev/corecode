import { useCallback, useEffect, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import { ApiError, requestJson } from '../lib/api';
import type { ProgressStore } from '../lib/progress-store';
import type { Problem } from '../schemas/catalog';
import { JobSnapshotSchema, RunResultSchema, type JobSnapshot } from '../schemas/submissions';
import type { Execution } from '../components/Results';

type Action = { controller: AbortController; jobId?: string };

// Resolve after `ms`, or as soon as `signal` aborts.
const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
    signal.addEventListener('abort', () => resolve(), { once: true });
  });

// Sends a submission, retrying with the same UUID: the judge records it once however often it
// arrives. A 4xx answer is final, since the problem changed or the input can never be accepted.
async function send(body: object, signal: AbortSignal): Promise<JobSnapshot> {
  for (let attempt = 1; ; attempt++) {
    try {
      const { value } = await requestJson('/api/run', { body, signal, timeoutMs: 30_000 });
      return JobSnapshotSchema.parse(value);
    } catch (error) {
      const final = error instanceof ApiError && error.status < 500 && error.status !== 429;
      if (final || signal.aborted || attempt === 3) throw error;
      await pause(1000 * attempt, signal);
    }
  }
}

// Polls once a second until the job finishes, backing off while its status is unavailable.
async function watch(job: JobSnapshot, signal: AbortSignal, show: (job: JobSnapshot) => void) {
  let failures = 0;
  while (['queued', 'running', 'canceling'].includes(job.state)) {
    await pause(failures ? Math.min(1000 * 2 ** (failures - 1), 8000) : 1000, signal);
    try {
      const { value } = await requestJson(`/api/jobs/${job.jobId}`, { signal, timeoutMs: 30_000 });
      job = JobSnapshotSchema.parse(value);
      failures = 0;
      show(job);
    } catch (error) {
      if (signal.aborted) throw error;
      if (++failures > 5)
        throw new Error(
          'Submission status is unavailable. Your submission is saved, and its result will appear under Submissions.',
        );
    }
  }
  return job;
}

// Run, Submit, and Stop. Leaving the page stops watching; a submission keeps running on the
// judge, and its result appears under Submissions.
export function useRunner(
  store: ProgressStore,
  problem: Problem,
  code: string,
  onStart: () => void,
) {
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [execution, setExecution] = useState<Execution | null>(null);
  const [running, setRunning] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState('');
  const active = useRef<Action | null>(null);

  useEffect(() => {
    void store.refresh();
    return () => active.current?.controller.abort();
  }, [store]);

  const execute = useCallback(
    async (mode: 'example' | 'submit') => {
      if (active.current) return;
      const action: Action = { controller: new AbortController() };
      active.current = action;
      const { signal } = action.controller;
      const submitted = code;
      const body = {
        problemId: problem.id,
        problemVersion: problem.version,
        code: submitted,
        mode,
      };
      const show = (job: JobSnapshot) =>
        setExecution({
          mode,
          jobState: job.state,
          result: job.result,
          error:
            job.state === 'canceled'
              ? 'Submission canceled. Your code is still in the editor.'
              : job.error,
          code: submitted,
        });
      setExecution({ mode });
      setRunning(true);
      onStart();
      setNotice('');
      setConsoleOpen(true);
      try {
        if (mode === 'example') {
          const { value } = await requestJson('/api/run', { body, signal, timeoutMs: 60_000 });
          setExecution({ mode, result: RunResultSchema.parse(value), code: submitted });
          return;
        }
        let job = await send({ ...body, submissionId: crypto.randomUUID() }, signal);
        action.jobId = job.jobId;
        show(job);
        job = await watch(job, signal, show);
        await store.refresh();
        const result = job.result;
        if (result && !result.error && result.cases.every((test) => test.passed && !test.error))
          void confetti({ particleCount: 80, spread: 70, disableForReducedMotion: true });
      } catch (reason) {
        if (signal.aborted) return;
        setExecution({
          mode,
          code: submitted,
          error: reason instanceof Error ? reason.message : 'The run failed. Please try again.',
        });
      } finally {
        if (active.current === action) {
          active.current = null;
          setRunning(false);
          setStopping(false);
        }
      }
    },
    [store, problem, code, onStart],
  );

  // Ctrl+Enter runs the example; Ctrl+Shift+Enter submits.
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key === 'Enter' &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault();
        void execute(event.shiftKey ? 'submit' : 'example');
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [execute]);

  // Stop: abandon a Run, or a submission the judge hasn't confirmed; cancel a confirmed one,
  // which the next poll shows as canceling, then canceled.
  async function cancel() {
    const action = active.current;
    if (!action || stopping) return;
    setStopping(true);
    if (!action.jobId) {
      action.controller.abort();
      setExecution((current) => ({
        mode: current?.mode ?? 'example',
        error: 'Stopped. Your code is still in the editor.',
      }));
      return;
    }
    try {
      await requestJson(`/api/jobs/${action.jobId}/cancel`, { body: {}, timeoutMs: 30_000 });
    } catch (error) {
      setStopping(false);
      setNotice(error instanceof Error ? error.message : 'Stop could not be confirmed.');
    }
  }

  function clearResult() {
    setExecution(null);
  }

  return {
    execution,
    running,
    stopping,
    notice,
    setNotice,
    consoleOpen,
    setConsoleOpen,
    execute,
    cancel,
    clearResult,
  };
}
