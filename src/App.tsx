import {
  Activity,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  ArrowLeft,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Code2,
  List,
  Play,
  RotateCcw,
  Square,
  X,
} from 'lucide-react';
import CodeEditor from './components/CodeEditor';
import Modal from './components/Modal';
import ProgressModal from './components/ProgressModal';
import PracticeLibrary from './components/PracticeLibrary';
import ProblemPanel, { type ProblemTab } from './components/ProblemPanel';
import Results, { type Execution } from './components/Results';
import type { Exercise } from './lib/exercises';
import {
  MAX_ATTEMPTS_PER_EXERCISE,
  MAX_CODE_BYTES,
  type Attempt,
  type ProgressData,
} from './lib/progress';
import { OUTBOX_PREFIX, type Catalog, type ProgressClient } from './lib/database-client';
import type { RunnerStage } from './lib/runner';
import { PracticeRunner } from './lib/practice-runner';

type Pane = 'results' | 'input';

export default function App({ catalog, client }: { catalog: Catalog; client: ProgressClient }) {
  if (!catalog.exercises.length) return <EmptyCatalog catalog={catalog} client={client} />;
  return <WorkspaceApp catalog={catalog} client={client} />;
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

function WorkspaceApp({ catalog, client }: { catalog: Catalog; client: ProgressClient }) {
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
  const initialExercise = useCallback(() => {
    let requested = '';
    try {
      requested = decodeURIComponent(location.hash.slice(1));
    } catch {
      /* Invalid links fall back to the catalog. */
    }
    return exercises.find((item) => item.id === requested) ?? exercises[0];
  }, [exercises]);
  const [exercise, setExercise] = useState(initialExercise);
  const [page, setPage] = useState<'library' | 'workspace'>(() =>
    exercises.some((item) => `#${item.id}` === location.hash) ? 'workspace' : 'library',
  );
  const [leftTab, setLeftTab] = useState<ProblemTab>('question');
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [showProgress, setShowProgress] = useState(false);
  const [showReset, setShowReset] = useState(false);
  const [mobilePane, setMobilePane] = useState('problem');
  const [pane, setPane] = useState<Pane>('results');
  const [customInput, setCustomInput] = useState(exercise.customInput ?? '()');
  const [execution, setExecution] = useState<Execution | null>(null);
  const [stage, setStage] = useState<RunnerStage | null>(null);
  const [notice, setNotice] = useState('');
  const [viewAttempt, setViewAttempt] = useState<Attempt | null>(null);
  const runner = useRef<PracticeRunner | null>(null);
  const request = useRef(0);
  const code = data.exercises[exercise.id]?.draft ?? exercise.starterCode;
  const attempts = data.exercises[exercise.id]?.attempts ?? [];
  const ready = Boolean(exercise.cases?.length);
  const supportsCustomInput =
    exercise.runtime === 'browser-python' ||
    !exercise.runtime ||
    Boolean(exercise.supportsCustomInput);
  const currentIndex = readyExercises.findIndex((item) => item.id === exercise.id);

  useEffect(() => {
    try {
      runner.current = new PracticeRunner();
    } catch {
      setNotice('For Python execution, open http://127.0.0.1:5173.');
    }
    return () => runner.current?.dispose();
  }, []);
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

  const selectExercise = useCallback(
    (next: Exercise, updateUrl = true, tab: 'question' | 'solution' = 'question') => {
      ++request.current;
      runner.current?.cancel();
      setStage(null);
      setExercise(next);
      setCustomInput(next.customInput ?? '()');
      setExecution(null);
      setLeftTab(tab);
      setPane('results');
      setNotice('');
      setPage('workspace');
      setConsoleOpen(false);
      setMobilePane('problem');
      if (updateUrl) history.pushState(null, '', `#${encodeURIComponent(next.id)}`);
    },
    [],
  );
  useEffect(() => {
    const navigate = () => {
      if (location.hash === '#library' || !location.hash) {
        ++request.current;
        runner.current?.cancel();
        setStage(null);
        setPage('library');
      } else selectExercise(initialExercise(), false);
    };
    window.addEventListener('popstate', navigate);
    window.addEventListener('hashchange', navigate);
    return () => {
      window.removeEventListener('popstate', navigate);
      window.removeEventListener('hashchange', navigate);
    };
  }, [selectExercise, initialExercise]);
  useEffect(() => {
    document.title =
      page === 'library' ? 'Practice · Code Practice' : `${exercise.title} · Code Practice`;
  }, [exercise.title, page]);
  function openLibrary() {
    ++request.current;
    runner.current?.cancel();
    setStage(null);
    setPage('library');
    history.pushState(null, '', '#library');
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
    async (mode: 'example' | 'submit' | 'custom') => {
      if (stage || !exercise.cases || !runner.current) return;
      const ticket = ++request.current;
      const submittedCode = code;
      const started = performance.now();
      setPane('results');
      setExecution(null);
      setStage('loading');
      setMobilePane('code');
      setNotice('');
      setConsoleOpen(true);
      let attempt: Attempt | undefined;
      try {
        const result = await runner.current.run(
          exercise,
          submittedCode,
          mode,
          customInput,
          (next) => {
            if (ticket === request.current) setStage(next);
          },
        );
        if (ticket !== request.current) return;
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
        }
      } catch (reason) {
        if (ticket !== request.current) return;
        setExecution({
          mode,
          code: submittedCode,
          error: reason instanceof Error ? reason.message : 'The run failed. Please try again.',
        });
        if (mode === 'submit')
          attempt = {
            id: crypto.randomUUID(),
            at: new Date().toISOString(),
            code: submittedCode,
            problemVersion: exercise.version!,
            passed: 0,
            total: exercise.cases.length,
            status: 'error',
            durationMs: performance.now() - started,
          };
      } finally {
        if (ticket === request.current) setStage(null);
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
    [stage, exercise, code, customInput, setData],
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
  function cancel() {
    ++request.current;
    runner.current?.cancel();
    setStage(null);
    setExecution({ mode: 'example', error: 'Run canceled. Your code is still in the editor.' });
  }

  function navigateConsoleTabs(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!supportsCustomInput) return;
    const order: Pane[] = ['results', 'input'];
    const index = order.indexOf(pane);
    let next: number;

    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowLeft':
        next = 1 - index;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    setPane(order[next]);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next].focus();
  }

  function restoreProgress(next: ProgressData) {
    ++request.current;
    runner.current?.cancel();
    setStage(null);
    setExecution(null);
    client.restore(next);
  }

  function resetDraft() {
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
          href="#library"
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
      <Activity mode={page === 'library' ? 'visible' : 'hidden'}>
        <div className="library-page-shell">
          <PracticeLibrary
            progress={data}
            onSelect={(next, tab) => selectExercise(next, true, tab)}
            catalog={catalog}
            starred={stars}
            saveState={status}
            onStar={(id, value) => client.setStar(id, value)}
            onSolved={(item, value) => client.setSolved(item.id, value, item.starterCode)}
          />
        </div>
      </Activity>
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
                    disabled={Boolean(stage)}
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
                    readOnly={Boolean(stage)}
                  />
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
                  <div className="result-panel">
                    <div
                      className="result-tabs"
                      role="tablist"
                      aria-label="Execution details"
                      onKeyDown={navigateConsoleTabs}
                    >
                      <button
                        role="tab"
                        tabIndex={pane === 'results' ? 0 : -1}
                        aria-selected={pane === 'results'}
                        aria-controls="console-content"
                        id="tab-results"
                        className={pane === 'results' ? 'active' : ''}
                        onClick={() => setPane('results')}
                      >
                        Results
                      </button>
                      {supportsCustomInput && (
                        <button
                          role="tab"
                          tabIndex={pane === 'input' ? 0 : -1}
                          aria-selected={pane === 'input'}
                          aria-controls="console-content"
                          id="tab-input"
                          className={pane === 'input' ? 'active' : ''}
                          onClick={() => setPane('input')}
                        >
                          Custom input
                        </button>
                      )}
                    </div>
                    <div
                      className="result-body"
                      role="tabpanel"
                      id="console-content"
                      aria-labelledby={'tab-' + pane}
                    >
                      {pane === 'results' && (
                        <Results
                          execution={execution}
                          stage={stage}
                          stale={Boolean(execution?.code && execution.code !== code)}
                        />
                      )}
                      {pane === 'input' && (
                        <div className="custom-input">
                          <label htmlFor="custom-arguments">Function arguments</label>
                          <p>
                            Use a Python tuple, such as <code>('hello',)</code> for one argument.
                            Custom runs are not graded.
                          </p>
                          <textarea
                            id="custom-arguments"
                            value={customInput}
                            onChange={(event) => setCustomInput(event.target.value)}
                            maxLength={8000}
                            spellCheck={false}
                            disabled={!ready || Boolean(stage)}
                          />
                          <div className="custom-input-footer">
                            <button
                              className="button secondary"
                              disabled={!ready || Boolean(stage)}
                              onClick={() => void execute('custom')}
                            >
                              <Play size={14} /> Run input
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
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
                    {stage ? (
                      <button className="button stop" onClick={cancel}>
                        <Square size={14} /> Stop
                      </button>
                    ) : (
                      <>
                        <button
                          className="button secondary"
                          disabled={!ready}
                          onClick={() => void execute('example')}
                          aria-label="Run example"
                          title="Run example · Ctrl+Enter"
                        >
                          Run
                        </button>
                        <button
                          className="button primary"
                          disabled={!ready}
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
