'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useDatabase } from './DatabaseApp';
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Code2,
  List,
  RotateCcw,
  Square,
  X,
} from 'lucide-react';
import Modal from './components/Modal';
import ProgressModal from './components/ProgressModal';
import PracticeLibrary from './components/PracticeLibrary';
import type { ProblemTab } from './components/ProblemPanel';
import Results, {
  SubmissionCelebration,
  SubmissionConfetti,
  type Execution,
} from './components/Results';
import type { Exercise } from './lib/exercises';
import {
  MAX_ATTEMPTS_PER_EXERCISE,
  MAX_CODE_BYTES,
  type Attempt,
  type ProgressData,
} from './lib/progress';
import { OUTBOX_PREFIX, type Catalog, type ProgressClient } from './lib/database-client';
import {
  PracticeRunner,
  pendingSubmissionProblemIds,
  type ExecutionOutcome,
  type JobSnapshot,
} from './lib/practice-runner';

const CodeEditor = dynamic(() => import('./components/CodeEditor'), { ssr: false });
const ProblemPanel = dynamic(() => import('./components/ProblemPanel'));

export default function App({
  problemId,
  initialTab = 'question',
}: {
  problemId?: string;
  initialTab?: 'question' | 'solution';
}) {
  const { catalog, client } = useDatabase();
  if (problemId && !catalog.exercises.some((item) => item.id === problemId))
    return (
      <main className="empty-state">
        <h1>Problem not found</h1>
        <Link href="/" className="button primary">
          Back to practice
        </Link>
      </main>
    );
  if (!catalog.exercises.length) return <EmptyCatalog catalog={catalog} client={client} />;
  return (
    <WorkspaceApp
      key={problemId ?? 'library'}
      catalog={catalog}
      client={client}
      problemId={problemId}
      initialTab={initialTab}
    />
  );
}

function EmptyCatalog({ catalog, client }: { catalog: Catalog; client: ProgressClient }) {
  const state = useSyncExternalStore(client.subscribe, client.getSnapshot);
  return (
    <div className="app library-view">
      <header className="topbar">
        <span className="brand">Code Practice</span>
      </header>
      <PracticeLibrary
        catalog={catalog}
        progress={state.progress}
        starred={state.stars}
        saveState={state.status}
        onStar={(id, value) => client.setStar(id, value)}
        onSolved={(item, value) => client.setSolved(item.id, value, item.starterCode)}
        onSelect={() => {}}
      />
    </div>
  );
}

function WorkspaceApp({
  catalog,
  client,
  problemId,
  initialTab,
}: {
  catalog: Catalog;
  client: ProgressClient;
  problemId?: string;
  initialTab: 'question' | 'solution';
}) {
  const router = useRouter();
  const {
    progress: data,
    stars,
    status,
    warning,
  } = useSyncExternalStore(client.subscribe, client.getSnapshot);
  const setData = useCallback(
    (update: (previous: ProgressData) => ProgressData) => client.updateProgress(update),
    [client],
  );
  const { exercises } = catalog;
  const readyExercises = exercises.filter((item) => Boolean(item.cases?.length));
  const exercise = exercises.find((item) => item.id === problemId) ?? exercises[0];
  const page = problemId ? 'workspace' : 'library';
  const [leftTab, setLeftTab] = useState<ProblemTab>(initialTab);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [mobilePane, setMobilePane] = useState('problem');
  const [execution, setExecution] = useState<Execution | null>(null);
  const [celebration, setCelebration] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [recovering, setRecovering] = useState(page === 'workspace');
  const [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState('');
  const [viewAttempt, setViewAttempt] = useState<Attempt | null>(null);
  const runner = useRef<PracticeRunner | null>(null);
  const request = useRef(0);
  const cancellationNotice = useRef('');
  const code = data.exercises[exercise.id]?.draft ?? exercise.starterCode;
  const attempts = data.exercises[exercise.id]?.attempts ?? [];
  const ready = Boolean(exercise.cases?.length);
  const currentIndex = readyExercises.findIndex((item) => item.id === exercise.id);

  useEffect(() => {
    if (celebration === null) return;
    const timer = window.setTimeout(() => setCelebration(null), 2200);
    return () => window.clearTimeout(timer);
  }, [celebration]);

  const showJob = useCallback((job: JobSnapshot, ticket: number, submittedCode?: string) => {
    if (ticket !== request.current) return;
    if (!['queued', 'running'].includes(job.state)) {
      const previous = cancellationNotice.current;
      setNotice((current) => (current === previous ? '' : current));
      cancellationNotice.current = '';
    }
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
      await client.refresh();
      const job = outcome.job;
      if (job) {
        const saved = client
          .getSnapshot()
          .progress.exercises[job.problemId]?.attempts.find(
            (attempt) => attempt.id === `judge:${job.jobId}`,
          );
        showJob(job, ticket, outcome.code ?? saved?.code);
      }
    },
    [client, showJob],
  );

  useEffect(() => {
    const activeRunner = new PracticeRunner();
    runner.current = activeRunner;
    const ticket = ++request.current;
    if (page === 'workspace') {
      void activeRunner
        .recover(exercise, (job, submittedCode) => showJob(job, ticket, submittedCode))
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
    }
    return () => {
      ++request.current;
      activeRunner.detach();
    };
  }, [exercise, page, showDurableResult, showJob]);

  useEffect(() => {
    void client.refresh();
    if (page !== 'library') return;
    // Keep the library current when a submission finishes after leaving its editor.
    const observers = pendingSubmissionProblemIds().flatMap((id) => {
      const pendingExercise = exercises.find((item) => item.id === id);
      if (!pendingExercise) return [];
      const observer = new PracticeRunner();
      void observer
        .recover(pendingExercise)
        .then(() => client.refresh())
        .catch(() => {});
      return [observer];
    });
    return () => observers.forEach((observer) => observer.detach());
  }, [client, exercises, page]);
  useEffect(() => {
    const save = () => {
      void client.flush();
    };
    const refresh = () => {
      void client.refresh();
    };
    const storage = (event: StorageEvent) => {
      if (event.key?.startsWith(OUTBOX_PREFIX)) refresh();
    };
    window.addEventListener('pagehide', save);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    window.addEventListener('storage', storage);
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') save();
      else refresh();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.removeEventListener('pagehide', save);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      window.removeEventListener('storage', storage);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [client]);

  function selectExercise(next: Exercise, tab: 'question' | 'solution' = 'question') {
    ++request.current;
    runner.current?.detach();
    router.push(
      `/problems/${encodeURIComponent(next.id)}${tab === 'solution' ? '?tab=solution' : ''}`,
    );
  }
  useEffect(() => {
    document.title = page === 'library' ? 'Code Practice' : `${exercise.title} · Code Practice`;
  }, [exercise.title, page]);
  function openLibrary() {
    ++request.current;
    runner.current?.detach();
    setRunning(false);
    setCelebration(null);
    router.push('/');
  }

  function updateDraft(next: string) {
    if (new TextEncoder().encode(next).byteLength > MAX_CODE_BYTES) {
      setNotice('Keep your solution under 50 KiB of text. The larger edit was not saved.');
      return;
    }
    const now = new Date().toISOString();
    setData((previous) => ({
      ...previous,
      exercises: {
        ...previous.exercises,
        [exercise.id]: {
          draft: next,
          updatedAt: now,
          solved: previous.exercises[exercise.id]?.solved ?? false,
          attempts: previous.exercises[exercise.id]?.attempts ?? [],
        },
      },
    }));
  }

  const execute = useCallback(
    async (mode: 'example' | 'submit') => {
      if (running || recovering || stopping || !exercise.cases || !runner.current) return;
      const ticket = ++request.current;
      const submittedCode = code;
      setCelebration(null);
      setExecution({ mode });
      setRunning(true);
      setMobilePane('code');
      setNotice('');
      setConsoleOpen(true);
      let attempt: Attempt | undefined;
      try {
        const outcome = await runner.current.run(exercise, submittedCode, mode, {
          completionIntentIds:
            mode === 'submit' ? client.captureCompletionIntents(exercise.id) : [],
          onJob: (job, savedCode) => showJob(job, ticket, savedCode),
        });
        if (outcome.durable) {
          await showDurableResult(outcome, ticket);
          if (
            ticket === request.current &&
            outcome.result &&
            !outcome.result.error &&
            outcome.result.cases.length === exercise.cases.length &&
            outcome.result.cases.every((test) => test.passed === true && !test.error)
          )
            setCelebration(ticket);
          return;
        }
        if (ticket !== request.current) return;
        const result = outcome.result;
        if (!result) throw new Error('The runner did not return a result.');
        setExecution({ mode, result, code: submittedCode });
        if (mode === 'submit') {
          const passed = result.cases.filter((test) => test.passed).length;
          const total = exercise.cases.length;
          attempt = {
            id: crypto.randomUUID(),
            at: new Date().toISOString(),
            code: submittedCode,
            passed,
            total,
            problemVersion: exercise.version!,
            status: result.error ? 'error' : passed === total ? 'accepted' : 'failed',
            durationMs: result.durationMs,
          };
          if (
            attempt.status === 'accepted' &&
            total > 0 &&
            result.cases.length === total &&
            result.cases.every((test) => test.passed === true && !test.error)
          ) {
            setCelebration(ticket);
          }
        }
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
      if (attempt) {
        const completed = attempt;
        setData((previous) => ({
          ...previous,
          exercises: {
            ...previous.exercises,
            [exercise.id]: {
              draft: previous.exercises[exercise.id]?.draft ?? submittedCode,
              updatedAt: completed.at,
              solved: Boolean(
                previous.exercises[exercise.id]?.solved || completed.status === 'accepted',
              ),
              attempts: [...(previous.exercises[exercise.id]?.attempts ?? []), completed].slice(
                -MAX_ATTEMPTS_PER_EXERCISE,
              ),
            },
          },
        }));
      }
    },
    [running, recovering, stopping, exercise, code, setData, client, showJob, showDurableResult],
  );
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        page === 'workspace' &&
        (event.ctrlKey || event.metaKey) &&
        event.key === 'Enter' &&
        !document.querySelector('dialog[open]')
      ) {
        event.preventDefault();
        void execute(event.shiftKey ? 'submit' : 'example');
      }
    };
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, [execute, page]);
  async function cancel() {
    if (stopping) return;
    setCelebration(null);
    const ticket = request.current;
    setStopping(true);
    try {
      const job = await runner.current?.cancel();
      if (ticket !== request.current) return;
      if (!job) {
        ++request.current;
        setRunning(false);
        setExecution({ mode: 'example', error: 'Run canceled. Your code is still in the editor.' });
      }
    } catch (error) {
      if (ticket === request.current) {
        cancellationNotice.current =
          error instanceof Error ? error.message : 'Cancellation could not be confirmed.';
        setNotice(cancellationNotice.current);
      }
    } finally {
      setStopping(false);
    }
  }

  function restoreProgress(next: ProgressData) {
    setCelebration(null);
    ++request.current;
    runner.current?.detach();
    setRunning(false);
    setRecovering(false);
    setExecution(null);
    client.restore(next);
  }

  function resetDraft() {
    setCelebration(null);
    updateDraft(exercise.starterCode);
    setShowReset(false);
    setExecution(null);
  }

  return (
    <div
      className={'app ' + (page === 'library' ? 'library-view' : 'ide-view')}
      data-save-state={status}
    >
      <header className="topbar">
        <a
          className="brand"
          href="/"
          onClick={(event) => {
            event.preventDefault();
            openLibrary();
          }}
          aria-label="Code Practice library"
        >
          <Code2 size={21} />
          <span>Code Practice</span>
        </a>
        {page === 'workspace' && (
          <div className="ide-navigation">
            <button className="button quiet" aria-label="Back to practice" onClick={openLibrary}>
              <List size={17} /> {exercise.deck}
            </button>
            <div className="exercise-navigation">
              <button
                className="icon-button"
                aria-label="Previous exercise"
                disabled={currentIndex <= 0}
                onClick={() => selectExercise(readyExercises[currentIndex - 1])}
              >
                <ChevronLeft size={17} />
              </button>
              <button
                className="icon-button"
                aria-label="Next exercise"
                disabled={currentIndex < 0 || currentIndex >= readyExercises.length - 1}
                onClick={() => selectExercise(readyExercises[currentIndex + 1])}
              >
                <ChevronRight size={17} />
              </button>
            </div>
          </div>
        )}
      </header>
      {warning && (
        <div className="warning-banner" role="alert">
          {warning} <button onClick={client.retry}>Retry</button>{' '}
          <button onClick={() => setShowProgress(true)}>Export your progress</button>
        </div>
      )}
      {page === 'library' && (
        <div className="library-page-shell">
          <PracticeLibrary
            progress={data}
            onSelect={selectExercise}
            catalog={catalog}
            starred={stars}
            saveState={status}
            onStar={(id, value) => client.setStar(id, value)}
            onSolved={(item, value) => client.setSolved(item.id, value, item.starterCode)}
          />
        </div>
      )}
      {page === 'workspace' && (
        <div className="app-body">
          <main className="main-workspace">
            <div className="mobile-pane-tabs">
              <button
                aria-pressed={mobilePane === 'problem'}
                className={mobilePane === 'problem' ? 'active' : ''}
                onClick={() => setMobilePane('problem')}
              >
                <BookOpen size={16} /> Problem
              </button>
              <button
                aria-pressed={mobilePane === 'code'}
                className={mobilePane === 'code' ? 'active' : ''}
                onClick={() => setMobilePane('code')}
              >
                <Code2 size={16} /> Code & results
              </button>
            </div>
            <div className={'workspace-grid mobile-' + mobilePane}>
              {celebration !== null && <SubmissionConfetti key={celebration} />}
              <ProblemPanel
                exercise={exercise}
                solved={Boolean(data.exercises[exercise.id]?.solved)}
                attempts={attempts}
                tab={leftTab}
                onTabChange={setLeftTab}
                onViewAttempt={setViewAttempt}
              />
              <section className="coding-panel" aria-label="Coding workspace">
                <div className="editor-header">
                  <div>
                    <strong>{exercise.language}</strong>
                  </div>
                  <button
                    className="button quiet reset-button"
                    disabled={running}
                    onClick={() => setShowReset(true)}
                    title="Reset code"
                  >
                    <RotateCcw size={15} /> Reset
                  </button>
                </div>
                <div className="editor-area">
                  <CodeEditor
                    key={exercise.id}
                    code={code}
                    language={exercise.language}
                    onChange={updateDraft}
                    onLimit={() =>
                      setNotice(
                        'That edit exceeds the code size limit (32,768 characters / 50 KiB). Your existing code has been kept.',
                      )
                    }
                    readOnly={running && !execution?.jobState}
                  />
                  {celebration !== null && <SubmissionCelebration key={celebration} />}
                </div>
                {notice && (
                  <div className="notice" role="alert">
                    {notice}
                    <button
                      className="icon-button"
                      aria-label="Dismiss message"
                      onClick={() => setNotice('')}
                    >
                      <X size={14} />
                    </button>
                  </div>
                )}
                {consoleOpen && (
                  <section className="result-panel" aria-labelledby="console-results-title">
                    <header className="result-header">
                      <h2 id="console-results-title">Results</h2>
                    </header>
                    <div className="result-body">
                      <Results
                        execution={execution}
                        running={running}
                        stale={execution?.code !== undefined && execution.code !== code}
                      />
                    </div>
                  </section>
                )}
                <div className="action-bar">
                  <button
                    className="console-toggle"
                    aria-label="Console"
                    aria-expanded={consoleOpen}
                    onClick={() => setConsoleOpen((value) => !value)}
                  >
                    Console{consoleOpen ? <ChevronDown size={15} /> : <ChevronUp size={15} />}
                  </button>
                  <div>
                    {running || stopping ? (
                      <button
                        className="button stop"
                        onClick={() => void cancel()}
                        disabled={stopping || execution?.jobState === 'canceling'}
                      >
                        <Square size={14} />{' '}
                        {stopping || execution?.jobState === 'canceling' ? 'Stopping…' : 'Stop'}
                      </button>
                    ) : (
                      <>
                        <button
                          className="button secondary"
                          disabled={!ready || recovering}
                          onClick={() => void execute('example')}
                          aria-label="Run example"
                          title="Run example · Ctrl+Enter"
                        >
                          Run
                        </button>
                        <button
                          className="button primary"
                          disabled={!ready || recovering}
                          onClick={() => void execute('submit')}
                          title="Ctrl+Shift+Enter"
                        >
                          Submit
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </section>
            </div>
          </main>
        </div>
      )}
      {showProgress && (
        <ProgressModal
          data={data}
          readyExercises={readyExercises}
          onClose={() => setShowProgress(false)}
          onRestore={restoreProgress}
        />
      )}
      {showReset && (
        <Modal title="Reset this solution?" onClose={() => setShowReset(false)}>
          <p className="modal-description">
            This replaces your current draft with the starter code. Your past submissions and solved
            status will stay.
          </p>
          <div className="modal-actions">
            <button className="button secondary" onClick={() => setShowReset(false)}>
              Keep editing
            </button>
            <button className="button primary" onClick={resetDraft}>
              Reset code
            </button>
          </div>
        </Modal>
      )}
      {viewAttempt && (
        <Modal title="Saved submission" onClose={() => setViewAttempt(null)} wide>
          <p className="modal-description">
            {new Date(viewAttempt.at).toLocaleString()} · {viewAttempt.passed}/{viewAttempt.total}{' '}
            passed
          </p>
          <div className="attempt-code">
            <CodeEditor code={viewAttempt.code} language={exercise.language} readOnly />
          </div>
          <div className="modal-actions">
            <button className="button secondary" onClick={() => setViewAttempt(null)}>
              <ArrowLeft size={15} /> Back to editor
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
