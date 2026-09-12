import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createSandboxCatalogPlan,
  parseCatalogArguments,
  verifySandboxCatalog,
} from '../verify-catalog.mjs';

// Every dependency is injected. No environment file, database, cloud API, Docker,
// browser, or candidate implementation is accessed or executed by this suite.
const options = (extra = []) =>
  parseCatalogArguments([
    '--sandbox',
    '--confirm-cloud-usage',
    '--snapshot',
    'snap_fixture',
    ...extra,
  ]);

function row(runtime = 'python', id = 'fixture-' + runtime) {
  const test = { name: 'Example', entryPoint: 'answer', args: '(1,)', expected: '2' };
  return {
    problem: {
      id,
      version: 'a'.repeat(64),
      runtime,
      referenceCode: 'reference fixture source',
      starterCode: 'starter fixture source',
      solutionAlternatives: [{ title: 'Alternative', code: 'alternative fixture source' }],
    },
    spec: {
      runtime: runtime === 'browser-python' ? 'python' : runtime,
      entryPoint: 'answer',
      ...(runtime === 'javascript' ? { syntax: 'javascript' } : {}),
      cases:
        runtime === 'javascript'
          ? [{ name: 'Example', input: '[1]', expected: '2', variant: 0, args: [1], value: 2 }]
          : [test],
    },
  };
}

const accepted = () => ({ cases: [{ passed: true, actual: '2' }], durationMs: 1, stdout: '' });
function answer(body) {
  let error;
  if (body.code.includes('return object()'))
    error = 'AssertionError: Returned <object object at 0x1234>';
  else if (body.code.includes('return undefined'))
    error =
      'page.evaluate: Error: Unexpected result: expected 2, received undefined\n    at eq (<anonymous>:12:3)';
  else if (body.code === 'starter fixture source')
    error = 'AssertionError: unfinished implementation';
  return error ? { cases: [{ passed: false, error }], durationMs: 1, stdout: '' } : accepted();
}

function dependencies(rows, execute = async (body) => answer(body)) {
  const output = [];
  const calls = [];
  let time = 0;
  return {
    output,
    calls,
    loadEnvironment: () => calls.push('environment'),
    readSnapshot: async () => {
      calls.push('read-only snapshot');
      return rows;
    },
    execute,
    report: (line) => output.push(line),
    now: () => time,
    delay: async (duration) => {
      time += duration;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

describe('opt-in hosted catalog verification', () => {
  it('keeps local invocation and rejects incomplete cloud consent before loading private settings', async () => {
    assert.deepEqual(parseCatalogArguments([]), {
      sandbox: false,
      selection: 'python,sql,shell,browser-python',
    });
    for (const args of [
      ['--sandbox'],
      ['--sandbox', '--snapshot', 'snap_fixture'],
      ['--sandbox', '--confirm-cloud-usage'],
      ['--confirm-cloud-usage'],
      ['--sandbox', '--confirm-cloud-usage', '--snapshot', 'snap_'],
      ['--sandbox', '--confirm-cloud-usage', '--snapshot', 'snap_fixture', '--limit', '1e2'],
      ['--sandbox', '--confirm-cloud-usage', '--snapshot', 'snap_fixture', '--plan', '--plan'],
    ])
      assert.throws(() => parseCatalogArguments(args));
    const deps = dependencies([row()]);
    await assert.rejects(verifySandboxCatalog({ ...options(), confirmed: false }, deps));
    assert.deepEqual(deps.calls, []);
  });

  it('plans all grading variants for current and legacy runtime labels with bounded selection', async () => {
    const rows = [row(), row('browser-python'), row('javascript')];
    const plan = createSandboxCatalogPlan(rows, options());
    assert.equal(plan.jobs, 12);
    assert.deepEqual(
      plan.entries[1].variants.map((variant) => variant.variant),
      ['reference', 'alternative-1', 'starter', 'wrong-answer'],
    );
    const deps = dependencies(rows, async () =>
      assert.fail('Planning must not allocate a sandbox.'),
    );
    const planned = await verifySandboxCatalog(
      options(['--runtimes', 'python', '--limit', '1', '--plan']),
      deps,
    );
    assert.equal(planned.status, 'planned');
    assert.equal(planned.selectedProblems, 1);
    assert.equal(planned.plannedJobs, 4);
    assert.deepEqual(deps.calls, ['environment', 'read-only snapshot']);
  });

  it('uses at most two fresh adapter calls at once and never changes or reports private specs', async () => {
    const rows = [row(), row('browser-python'), row('javascript')];
    rows[0].spec.privateMarker = 'private-grading-marker';
    const before = JSON.stringify(rows);
    let active = 0;
    let maximum = 0;
    const requests = [];
    const deps = dependencies(rows, async (body, problem, configuration) => {
      active++;
      maximum = Math.max(maximum, active);
      requests.push({ body, problem, configuration });
      assert.deepEqual(Object.keys(problem).sort(), ['gradingSpec', 'id', 'version']);
      assert.deepEqual(configuration, { snapshotId: 'snap_fixture' });
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return answer(body);
    });
    const report = await verifySandboxCatalog(options(), deps);
    assert.equal(report.status, 'passed');
    assert.equal(report.completedJobs, 12);
    assert.equal(report.passedJobs, 12);
    assert.equal(maximum, 2);
    assert.equal(active, 0);
    assert.equal(requests.length, 12);
    assert.equal(report.nativeBrowserProblems, 1);
    assert.equal(JSON.stringify(rows), before);
    assert.ok(!deps.output.join('\n').includes('private-grading-marker'));
    assert.ok(!deps.output.join('\n').includes('fixture source'));
  });

  it('spaces actual starts across both workers by 3.5 seconds using one shared fake-clock gate', async () => {
    let time = 0;
    let active = 0;
    let maximum = 0;
    let waiting = 0;
    let maximumWaiting = 0;
    const starts = [];
    const delays = [];
    const deps = dependencies([row(), row('browser-python'), row('javascript')], async (body) => {
      starts.push(time);
      maximum = Math.max(maximum, ++active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return answer(body);
    });
    deps.now = () => time;
    deps.delay = async (duration) => {
      delays.push(duration);
      maximumWaiting = Math.max(maximumWaiting, ++waiting);
      await Promise.resolve();
      time += duration;
      waiting--;
    };
    const report = await verifySandboxCatalog(options(), deps);
    assert.equal(report.status, 'passed');
    assert.equal(report.completedJobs, 12);
    assert.deepEqual(
      starts,
      Array.from({ length: 12 }, (_, index) => index * 3_500),
    );
    assert.deepEqual(delays, Array(11).fill(3_500));
    assert.equal(maximumWaiting, 1);
    assert.equal(maximum, 2);
    assert.equal(active, 0);
  });

  it('does not launch a queued job when another worker fails during the pacing wait', async () => {
    let time = 0;
    let launches = 0;
    const waiting = deferred();
    const releaseDelay = deferred();
    const failRun = deferred();
    const failureReported = deferred();
    const deps = dependencies([row(), row('javascript'), row('python', 'third')], async () => {
      launches++;
      await failRun.promise;
      throw Error('private-sdk-token-and-url');
    });
    deps.now = () => time;
    deps.delay = async (duration) => {
      assert.equal(duration, 3_500);
      waiting.resolve();
      await releaseDelay.promise;
      time += duration;
    };
    const record = deps.report;
    deps.report = (line) => {
      record(line);
      const event = JSON.parse(line);
      if (event.event === 'result' && event.status === 'failed') failureReported.resolve();
    };
    const pending = verifySandboxCatalog(options(), deps);
    await waiting.promise;
    assert.equal(launches, 1);
    failRun.resolve();
    await failureReported.promise;
    releaseDelay.resolve();
    const report = await pending;
    assert.equal(launches, 1);
    assert.equal(report.status, 'failed');
    assert.equal(report.completedJobs, 1);
    assert.equal(report.failedJobs, 1);
    assert.equal(report.unrunJobs, report.plannedJobs - 1);
    assert.ok(!JSON.stringify(report).includes('private-sdk-token-and-url'));
  });

  it('fails fast while awaiting the already-running sibling and retaining sanitized partial results', async () => {
    let calls = 0;
    let active = 0;
    const deps = dependencies([row(), row('javascript'), row('python', 'third')], async () => {
      const current = ++calls;
      active++;
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      if (current === 1) throw Error('private-sdk-token-and-url');
      return accepted();
    });
    const report = await verifySandboxCatalog(options(), deps);
    assert.equal(calls, 2);
    assert.equal(active, 0);
    assert.equal(report.status, 'failed');
    assert.equal(report.failedJobs, 1);
    assert.equal(report.completedJobs, 2);
    assert.equal(report.results[0].failure, 'execution-or-cleanup-error');
    assert.equal(report.unrunJobs, report.plannedJobs - 2);
    assert.ok(!JSON.stringify(report).includes('private-sdk-token-and-url'));
    assert.ok(!deps.output.join('').includes('private-sdk-token-and-url'));
  });

  it('does not count top-level errors, malformed outcomes, or browser failures as rejected starters', async () => {
    for (const result of [
      { cases: [], error: 'private runtime failure', durationMs: 0 },
      { cases: [{ passed: 'false' }], durationMs: 1 },
      { cases: [{ passed: false }], durationMs: NaN },
      {
        cases: [{ passed: false, error: 'Target page, context or browser has been closed' }],
        durationMs: 1,
      },
      accepted(),
    ]) {
      const deps = dependencies([row()], async (body) =>
        body.code === 'starter fixture source' ? result : answer(body),
      );
      const report = await verifySandboxCatalog(options(), deps);
      assert.equal(report.status, 'failed');
      assert.equal(report.results.at(-1).variant, 'starter');
      assert.equal(report.results.at(-1).status, 'failed');
    }
  });

  it('requires the deliberate wrong-value signature', async () => {
    const wrong = dependencies([row()], async (body) =>
      body.code.includes('return object()')
        ? { cases: [{ passed: false, error: 'SyntaxError: unrelated failure' }], durationMs: 1 }
        : answer(body),
    );
    const failedWrong = await verifySandboxCatalog(options(), wrong);
    assert.equal(failedWrong.results.at(-1).failure, 'wrong-answer-not-rejected');
  });

  it('never invents a wrong-value representative for scenario or backend cases', () => {
    const scenario = row();
    scenario.spec.cases[0].code = '';
    const backend = row('javascript', 'backend-fixture');
    const plan = createSandboxCatalogPlan([scenario, backend], options());
    for (const entry of plan.entries) {
      assert.ok(entry.variants.every((variant) => variant.variant !== 'wrong-answer'));
    }
  });

  it('sanitizes catalog read failures without executing any job', async () => {
    const deps = dependencies([], async () => assert.fail('No catalog means no cloud jobs.'));
    deps.readSnapshot = async () => {
      throw Error('postgresql://private-connection');
    };
    await assert.rejects(
      verifySandboxCatalog(options(), deps),
      (error) => /read-only catalog/.test(error.message) && !/postgresql/.test(error.message),
    );
    assert.deepEqual(deps.output, []);
  });
});
