import type { KeyboardEvent } from 'react';
import { Check, ChevronRight, Code2, FileCode2, History, X } from 'lucide-react';
import CodeEditor from './CodeEditor';
import type { Exercise } from '../lib/exercises';
import type { Attempt } from '../lib/progress';

const PROBLEM_TABS = [
  { id: 'question', label: 'Question', Icon: FileCode2 },
  { id: 'solution', label: 'Solution', Icon: Code2 },
  { id: 'history', label: 'Submissions', Icon: History },
] as const;

export type ProblemTab = (typeof PROBLEM_TABS)[number]['id'];

type ProblemPanelProps = {
  exercise: Exercise;
  solved: boolean;
  attempts: Attempt[];
  tab: ProblemTab;
  onTabChange: (tab: ProblemTab) => void;
  onViewAttempt: (attempt: Attempt) => void;
};

export default function ProblemPanel({
  exercise,
  solved,
  attempts,
  tab,
  onTabChange,
  onViewAttempt,
}: ProblemPanelProps) {
  function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
    const index = PROBLEM_TABS.findIndex((item) => item.id === tab);
    let next: number;

    switch (event.key) {
      case 'ArrowRight':
        next = (index + 1) % PROBLEM_TABS.length;
        break;
      case 'ArrowLeft':
        next = (index + PROBLEM_TABS.length - 1) % PROBLEM_TABS.length;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = PROBLEM_TABS.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    onTabChange(PROBLEM_TABS[next].id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next].focus();
  }

  return (
    <section className="problem-panel" aria-label="Problem description">
      <div
        className="question-tabs"
        role="tablist"
        aria-label="Problem details"
        onKeyDown={navigateTabs}
      >
        {PROBLEM_TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            role="tab"
            id={`tab-${id}`}
            aria-controls="question-content"
            aria-selected={tab === id}
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? 'active' : ''}
            onClick={() => onTabChange(id)}
          >
            <Icon size={16} /> {label}
            {id === 'history' && attempts.length > 0 && <small>{attempts.length}</small>}
          </button>
        ))}
      </div>
      <div
        className="problem-content"
        id="question-content"
        role="tabpanel"
        aria-labelledby={'tab-' + tab}
      >
        {tab === 'question' && <Question exercise={exercise} solved={solved} />}
        {tab === 'solution' && <ReferenceSolution exercise={exercise} />}
        {tab === 'history' && (
          <SubmissionHistory attempts={attempts} onViewAttempt={onViewAttempt} />
        )}
      </div>
    </section>
  );
}

function Question({ exercise, solved }: { exercise: Exercise; solved: boolean }) {
  return (
    <>
      <div className="problem-title-row">
        <h1>{exercise.title}</h1>
        {solved && <Check size={21} className="solved-label" aria-label="Solved" />}
      </div>
      <div className="problem-meta">
        <span className={'difficulty difficulty-' + exercise.difficulty.toLowerCase()}>
          {exercise.difficulty}
        </span>
        {exercise.topic && exercise.topic !== exercise.language && (
          <span className="topic-pill">{exercise.topic}</span>
        )}
      </div>
      <p className="problem-prompt">{exercise.prompt}</p>
      {exercise.examples?.map((example, index) => (
        <div className="example" data-runtime={exercise.runtime} key={index}>
          <h2>Example {index + 1}:</h2>
          <div
            className={
              example.inputLabel || example.outputLabel
                ? 'example-code example-scenario'
                : 'example-code'
            }
          >
            <div>
              <span>{example.inputLabel ?? 'Input'}:</span>
              <pre>{example.input}</pre>
            </div>
            <div>
              <span>{example.outputLabel ?? 'Output'}:</span>
              <pre>{example.output}</pre>
            </div>
          </div>
        </div>
      ))}
      {!!exercise.requirements?.length && (
        <div className="requirements">
          <h2>Requirements:</h2>
          <ul>
            {exercise.requirements.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function ReferenceSolution({ exercise }: { exercise: Exercise }) {
  return (
    <div className="reference-code">
      <h1>Reference solution</h1>
      {exercise.explanation && <p className="solution-explanation">{exercise.explanation}</p>}
      <CodeEditor code={exercise.referenceCode} language={exercise.language} readOnly />
      {exercise.solutionAlternatives?.map((alternative) => (
        <section className="solution-alternative" key={alternative.title}>
          <h2>{alternative.title}</h2>
          <p className="solution-explanation">{alternative.explanation}</p>
          <CodeEditor code={alternative.code} language={exercise.language} readOnly />
          {alternative.complexity && (
            <p className="solution-complexity">{alternative.complexity}</p>
          )}
        </section>
      ))}
    </div>
  );
}

function SubmissionHistory({
  attempts,
  onViewAttempt,
}: Pick<ProblemPanelProps, 'attempts' | 'onViewAttempt'>) {
  return (
    <>
      <h1>Your submissions</h1>
      {attempts.length ? (
        <div className="submission-list">
          {[...attempts].reverse().map((attempt) => (
            <button
              key={attempt.id}
              className="submission-row"
              onClick={() => onViewAttempt(attempt)}
            >
              <span className={attempt.status === 'accepted' ? 'success' : 'failure'}>
                {attempt.status === 'accepted' ? <Check size={16} /> : <X size={16} />}
                {attempt.status === 'accepted'
                  ? 'Accepted'
                  : attempt.status === 'failed'
                    ? 'Not accepted'
                    : 'Run error'}
              </span>
              <span>
                {attempt.passed}/{attempt.total} passed
              </span>
              <time dateTime={attempt.at}>
                {new Date(attempt.at).toLocaleString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </time>
              <ChevronRight size={15} />
            </button>
          ))}
        </div>
      ) : (
        <div className="empty-state">
          <History size={25} />
          <h3>No submissions yet</h3>
          <p>Your last 20 submissions for this exercise will appear here.</p>
        </div>
      )}
    </>
  );
}
