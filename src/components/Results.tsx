import { useEffect, useState, type CSSProperties } from 'react';
import { Check, CircleAlert, CircleCheck, LoaderCircle, Terminal, X } from 'lucide-react';
import type { RunResult } from '../lib/practice-runner';

export interface Execution {
  mode: 'example' | 'submit';
  result?: RunResult;
  error?: string;
  code?: string;
}

const confettiColors = ['#22c55e', '#559bf8', '#d65fa6', '#f2b84b', '#a482ed'];
const confetti = Array.from({ length: 28 }, (_, index) => {
  const angle = ((index % 14) / 13) * Math.PI;
  return {
    left: index < 14 ? '10%' : '90%',
    '--confetti-x': `${Math.round(Math.cos(angle) * 95)}px`,
    '--confetti-rise': `${Math.round(-30 - Math.sin(angle) * 65)}px`,
    '--confetti-fall': `${100 + (index % 5) * 18}px`,
    '--confetti-delay': `${(index % 4) * 45}ms`,
    '--confetti-color': confettiColors[index % confettiColors.length],
  } as CSSProperties;
});

/** Decorative only; the results heading already announces an accepted submission. */
export function SubmissionConfetti() {
  return (
    <div className="submission-confetti-bursts" aria-hidden="true">
      {confetti.map((style, index) => (
        <span className="submission-confetti" key={index} style={style} />
      ))}
    </div>
  );
}

export function SubmissionCelebration() {
  return (
    <div className="submission-celebration" aria-hidden="true">
      <span className="submission-celebration-check">
        <Check size={56} strokeWidth={3.5} />
      </span>
    </div>
  );
}

export default function Results({
  execution,
  running,
  stale = false,
}: {
  execution: Execution | null;
  running: boolean;
  stale?: boolean;
}) {
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [execution]);
  if (running)
    return (
      <div className="empty-state execution-pending" role="status">
        <LoaderCircle className="spin" size={25} />
        <h3>Running your code…</h3>
        <p>You can stop this run at any time.</p>
      </div>
    );
  if (!execution)
    return (
      <div className="empty-state">
        <Terminal size={25} />
        <h3>Try your solution</h3>
        <p>
          Run the example to check your approach.
          <br />
          Submit to check the full set of cases.
        </p>
      </div>
    );
  if (execution.error || execution.result?.error)
    return (
      <div className="execution-error" role="alert">
        <h3>
          <CircleAlert size={19} /> Run stopped
        </h3>
        <pre>{execution.error || execution.result?.error}</pre>
        <p>Check your code, then try again. This run has not been marked as solved.</p>
      </div>
    );
  const result = execution.result;
  if (!result) return null;
  const passed = result.cases.filter((test) => test.passed).length;
  const success = passed === result.cases.length && result.cases.length > 0;
  const test = result.cases[active] ?? result.cases[0];
  const outputState =
    test?.error || test?.passed === false
      ? 'wrong-output'
      : test?.passed === true
        ? 'correct-output'
        : '';
  return (
    <div className="result-content">
      {stale && (
        <p className="stale-result" role="status">
          Your code has changed. These results are from the previous run.
        </p>
      )}
      <div className={`result-heading ${success ? 'success' : 'failure'}`} role="status">
        {success ? <CircleCheck size={20} /> : <CircleAlert size={20} />}
        <strong>
          {success
            ? execution.mode === 'submit'
              ? 'Accepted'
              : 'Example passed'
            : 'Not quite yet'}
        </strong>
        <span>
          {passed} / {result.cases.length} cases passed
        </span>
      </div>
      <div className="case-tabs" aria-label="Test cases">
        {result.cases.map((item, index) => (
          <button
            key={index}
            className={`${active === index ? 'active' : ''} ${item.passed ? 'pass' : 'fail'}`}
            onClick={() => setActive(index)}
            aria-pressed={active === index}
            aria-label={`Case ${index + 1}: ${item.passed ? 'passed' : 'failed'}`}
            title={item.name}
          >
            {item.passed ? <Check size={13} /> : <X size={13} />} Case {index + 1}
          </button>
        ))}
      </div>
      {test && (
        <div className="case-detail">
          <section className="value-block" aria-label="Input">
            <span>Input</span>
            <pre>{test.input}</pre>
          </section>
          <section
            className={`value-block ${outputState}`}
            aria-label={test.error ? 'Error' : 'Your Output'}
          >
            <span>{test.error ? 'Error' : 'Your Output'}</span>
            <pre>{test.error ?? test.actual ?? '(no output)'}</pre>
          </section>
          {test.expected !== undefined && (
            <section className="value-block expected-output" aria-label="Expected Output">
              <span>Expected Output</span>
              <pre>{test.expected}</pre>
            </section>
          )}
        </div>
      )}
      {result.stdout && (
        <details className="stdout" open>
          <summary>Console output</summary>
          <pre>{result.stdout}</pre>
        </details>
      )}
    </div>
  );
}
