import { useEffect, useState } from 'react';
import { Check, CircleAlert, CircleCheck, LoaderCircle, Terminal, X } from 'lucide-react';
import type { RunResult, RunnerStage } from '../lib/runner';

export interface Execution {
  mode: 'example' | 'submit' | 'custom';
  result?: RunResult;
  error?: string;
  code?: string;
}

export default function Results({
  execution,
  stage,
  stale = false,
}: {
  execution: Execution | null;
  stage: RunnerStage | null;
  stale?: boolean;
}) {
  const [active, setActive] = useState(0);
  useEffect(() => setActive(0), [execution]);
  if (stage)
    return (
      <div className="empty-state execution-pending" role="status">
        <LoaderCircle className="spin" size={25} />
        <h3>{stage === 'loading' ? 'Starting the runner…' : 'Running your code…'}</h3>
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
  const custom = execution.mode === 'custom';
  const success = !custom && passed === result.cases.length && result.cases.length > 0;
  const test = result.cases[active] ?? result.cases[0];
  const outputState =
    test?.error || (!custom && test?.passed === false)
      ? 'wrong-output'
      : !custom && test?.passed === true
        ? 'correct-output'
        : '';
  return (
    <div className="result-content">
      {stale && (
        <p className="stale-result" role="status">
          Your code has changed. These results are from the previous run.
        </p>
      )}
      <div
        className={`result-heading ${success ? 'success' : custom ? '' : 'failure'}`}
        role="status"
      >
        {success ? (
          <CircleCheck size={20} />
        ) : custom ? (
          <Terminal size={20} />
        ) : (
          <CircleAlert size={20} />
        )}
        <strong>
          {custom
            ? 'Custom run'
            : success
              ? execution.mode === 'submit'
                ? 'Accepted'
                : 'Example passed'
              : 'Not quite yet'}
        </strong>
        <span>{custom ? 'Not graded' : `${passed} / ${result.cases.length} cases passed`}</span>
      </div>
      {!custom && (
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
      )}
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
          {!custom && test.expected !== undefined && (
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
