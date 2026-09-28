import { useCallback, useEffect, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import { Runner, type ExecutionOutcome, type JobSnapshot } from '../lib/runner';
import type { ProgressStore } from '../lib/progress-store';
import type { Problem } from '../schemas/catalog';
import type { Execution } from '../components/Results';

/**
 * Run, Submit, Stop, and reconnecting to a durable submission. Each action takes a
 * new ticket, so results that arrive for an older ticket are ignored.
 */
export function useRunner(
  store: ProgressStore,
  problem: Problem,
  code: string,
  onStart: () => void,
) {
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [execution, setExecution] = useState<Execution | null>(null);
  const [running, setRunning] = useState(false);
  const [recovering, setRecovering] = useState(true);
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState('');
  const runner = useRef<Runner | null>(null);
  const request = useRef(0);

  const showJob = useCallback((job: JobSnapshot, ticket: number, submittedCode?: string) => {
    if (ticket !== request.current) return;
    setRecovering(false);
    setRunning(['queued', 'running', 'canceling'].includes(job.state));
    setConsoleOpen(true);
    setExecution({
      mode: 'submit',
      jobState: job.state,
      result: job.result,
      error:
        job.state === 'canceled'
          ? 'Submission canceled. Your code is still in the editor.'
          : job.error,
      code: submittedCode,
    });
  }, []);

  const showDurableResult = useCallback(
    async (outcome: ExecutionOutcome, ticket: number) => {
      await store.refresh();
      const job = outcome.job;
      if (job) {
        const saved = store
          .getSnapshot()
          .progress.exercises[job.problemId]?.attempts.find(
            (attempt) => attempt.id === `judge:${job.jobId}`,
          );
        showJob(job, ticket, outcome.code ?? saved?.code);
      }
    },
    [store, showJob],
  );

  // Reconnect to a pending or recent submission for this problem.
  useEffect(() => {
    void store.refresh();
    const activeRunner = new Runner();
    runner.current = activeRunner;
    const ticket = ++request.current;
    void activeRunner
      .recover(problem, (job, submittedCode) => showJob(job, ticket, submittedCode))
      .then(async (outcome) => {
        if (outcome) await showDurableResult(outcome, ticket);
      })
      .catch((error) => {
        if (ticket !== request.current) return;
        setConsoleOpen(true);
        setExecution({
          mode: 'submit',
          error: error.message ?? 'Could not reconnect to your submission.',
        });
      })
      .finally(() => {
        if (ticket === request.current) {
          setRecovering(false);
          setRunning(false);
        }
      });
    return () => {
      ++request.current;
      activeRunner.detach();
    };
  }, [store, problem, showDurableResult, showJob]);

  const execute = useCallback(
    async (mode: 'example' | 'submit') => {
      if (running || recovering || stopping || !runner.current) return;
      const ticket = ++request.current;
      const submittedCode = code;
      setExecution({ mode });
      setRunning(true);
      onStart();
      setNotice('');
      setConsoleOpen(true);
      try {
        const outcome = await runner.current.run(problem, submittedCode, mode, (job, savedCode) =>
          showJob(job, ticket, savedCode),
        );
        if (outcome.job) {
          await showDurableResult(outcome, ticket);
          if (
            ticket === request.current &&
            outcome.result &&
            !outcome.result.error &&
            outcome.result.cases.every((test) => test.passed === true && !test.error)
          )
            void confetti({ particleCount: 80, spread: 70, disableForReducedMotion: true });
          return;
        }
        if (ticket !== request.current) return;
        const result = outcome.result;
        if (!result) throw new Error('The runner did not return a result.');
        setExecution({ mode, result, code: submittedCode });
      } catch (reason) {
        if (ticket !== request.current) return;
        setExecution({
          mode,
          code: submittedCode,
          error: reason instanceof Error ? reason.message : 'The run failed. Please try again.',
        });
      } finally {
        if (ticket === request.current) setRunning(false);
      }
    },
    [running, recovering, stopping, problem, code, onStart, showJob, showDurableResult],
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

  async function cancel() {
    if (stopping) return;
    const ticket = request.current;
    setStopping(true);
    try {
      const job = await runner.current?.cancel();
      if (ticket !== request.current) return;
      if (!job) {
        ++request.current;
        setRunning(false);
        setExecution((current) => ({
          mode: current?.mode ?? 'example',
          error: 'Stopped. Your code is still in the editor.',
        }));
      }
    } catch (error) {
      if (ticket === request.current)
        setNotice(error instanceof Error ? error.message : 'Stop could not be confirmed.');
    } finally {
      setStopping(false);
    }
  }

  function clearResult() {
    setExecution(null);
  }

  return {
    execution,
    running,
    recovering,
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
