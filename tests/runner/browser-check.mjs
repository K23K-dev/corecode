// Reads the current catalog from Neon, then uses Vite and the browser runner only.
// The snapshot is read-only, application API requests are blocked, and no code runs in host Python.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { loadTestEnvironment } from '../e2e/database-runtime.mjs';
import { readCatalogSnapshot } from '../grading-data.mjs';

loadTestEnvironment();
const catalog = (await readCatalogSnapshot()).exercises.filter(
  (exercise) => exercise.runtime === 'browser-python',
);
assert.equal(catalog.length, 15);
assert.equal(
  catalog.reduce((total, exercise) => total + exercise.cases.length, 0),
  125,
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
});
const checks = [];
const catalogChecks = [];
try {
  const page = await browser.newPage();
  // Chromium treats the synthetic root as non-local; only this test origin may
  // reach the loopback runner. Its production CSP and the API block stay active.
  await page.context().grantPermissions(['local-network-access'], {
    origin: 'http://127.0.0.1:5173',
  });
  const apiAttempts = [];
  await page.route(
    (url) => url.pathname === '/api' || url.pathname.startsWith('/api/'),
    (route) => {
      apiAttempts.push(new URL(route.request().url()).pathname);
      return route.abort('blockedbyclient');
    },
  );
  // Load only the runner client; the normal app page would initialize persistence.
  await page.route('http://127.0.0.1:5173/', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta charset="utf-8"><title>Runner verification</title></head><body></body></html>',
    }),
  );
  await page.goto('http://127.0.0.1:5173');
  await page.evaluate(async () => {
    const { PythonRunner } = await import('/src/lib/runner.ts');
    window.protocolTestRunner = new PythonRunner();
  });
  const run = (request) =>
    page.evaluate(async (payload) => {
      const stages = [];
      try {
        const result = await window.protocolTestRunner.run(payload, (stage) => stages.push(stage));
        return { result, stages };
      } catch (error) {
        return { rejected: error.message, stages };
      }
    }, request);
  const caseFor = (args, expected, check) => ({
    name: 'Example',
    args,
    expected,
    ...(check ? { check } : {}),
  });
  let response = await run({
    code: 'def answer(xs):\n    return list(reversed(xs))',
    entryPoint: 'answer',
    cases: [caseFor('([1, 2, 3],)', '[3, 2, 1]', 'unchanged')],
  });
  assert.equal(response.result?.cases[0].passed, true, JSON.stringify(response));
  assert.deepEqual(response.stages, ['loading', 'running']);
  checks.push('real CSP bootstrap and equivalent implementation');

  response = await run({
    code: 'class Solution:\n    def answer(self, value):\n        return self.double(value)\n    def double(self, value):\n        return value * 2',
    entryPoint: 'answer',
    cases: [caseFor('(4,)', '8')],
  });
  assert.equal(response.result?.cases[0].passed, true, JSON.stringify(response));
  checks.push('Solution instance methods can call helper methods');

  response = await run({
    code: 'def answer(value):\n    return -1\nclass Solution:\n    def answer(self, value):\n        return value + 1',
    entryPoint: 'answer',
    cases: [caseFor('(7,)', '8')],
  });
  assert.equal(response.result?.cases[0].passed, true, JSON.stringify(response));
  checks.push('Solution method takes precedence over a same-name standalone function');

  response = await run({
    code: 'class Solution:\n    def __init__(self):\n        self.calls = 0\n    def answer(self):\n        self.calls += 1\n        return self.calls',
    entryPoint: 'answer',
    cases: [caseFor('()', '1'), caseFor('()', '1')],
  });
  assert(
    response.result?.cases.every((testCase) => testCase.passed === true),
    JSON.stringify(response),
  );
  checks.push('Solution receives a fresh instance for each test case');

  response = await run({
    code: 'class Solution:\n    def different(self):\n        return 1',
    entryPoint: 'answer',
    cases: [caseFor('()', '1')],
  });
  assert.match(response.result?.error, /Solution\.answer/);
  checks.push('missing Solution method reports the expected name');

  response = await run({
    code: 'def answer(xs):\n    return tuple(reversed(xs))',
    entryPoint: 'answer',
    cases: [caseFor('([1, 2, 3],)', '[3, 2, 1]')],
  });
  assert.equal(response.result.cases[0].passed, false);
  checks.push('recursive strict type comparison');

  response = await run({
    code: 'def answer(xs):\n    xs.reverse()\n    return xs',
    entryPoint: 'answer',
    cases: [caseFor('([1, 2, 3],)', '[3, 2, 1]', 'unchanged')],
  });
  assert.equal(response.result.cases[0].passed, false);
  assert.match(response.result.cases[0].error, /changed its input/);
  checks.push('input mutation detection');

  response = await run({
    code: 'def answer():\n    return [[0, 0]] * 2',
    entryPoint: 'answer',
    cases: [caseFor('()', '[[0, 0], [0, 0]]', 'independent_rows')],
  });
  assert.equal(response.result.cases[0].passed, false);
  assert.match(response.result.cases[0].error, /separate list/);
  checks.push('independent row detection');

  response = await run({
    code: 'def answer(value):\n    return value + 1',
    entryPoint: 'answer',
    cases: [],
    customArgs: '(7,)',
  });
  assert.equal(response.result.cases[0].actual, '8');
  assert.equal(response.result.cases[0].passed, undefined);
  assert.equal(response.result.cases[0].expected, undefined);
  checks.push('custom input is explicitly ungraded');

  response = await run({
    code: 'class Solution:\n    def answer(self, value):\n        return value + 1',
    entryPoint: 'answer',
    cases: [],
    customArgs: '(7,)',
  });
  assert.equal(response.result.cases[0].actual, '8');
  assert.equal(response.result.cases[0].passed, undefined);
  assert.equal(response.result.cases[0].expected, undefined);
  checks.push('Solution custom input stays explicitly ungraded');

  response = await run({
    code: 'def answer(value):\n    return value',
    entryPoint: 'answer',
    cases: [],
    customArgs: '__import__("os").getcwd()',
  });
  assert.match(response.result.cases[0].error, /ValueError/);
  checks.push('custom input only accepts literal tuples');

  response = await run({
    code: 'def answer():\n    raise SystemExit("example")',
    entryPoint: 'answer',
    cases: [caseFor('()', 'None')],
  });
  assert.match(response.result.cases[0].error, /SystemExit/);
  checks.push('BaseException feedback instead of runtime termination');

  response = await run({
    code: 'print("a" * 20000)\ndef answer():\n    return 1',
    entryPoint: 'answer',
    cases: [caseFor('()', '1')],
  });
  assert(response.result.stdout.length <= 8_224);
  assert.match(response.result.stdout, /truncated/);
  checks.push('bounded stdout');

  response = await run({
    code: 'import builtins\nbuiltins.practice_marker = 123\ndef answer():\n    return 1',
    entryPoint: 'answer',
    cases: [caseFor('()', '1')],
  });
  assert.equal(response.result.cases[0].passed, true);
  response = await run({
    code: 'import builtins\ndef answer():\n    return hasattr(builtins, "practice_marker")',
    entryPoint: 'answer',
    cases: [caseFor('()', 'False')],
  });
  assert.equal(response.result.cases[0].passed, true);
  checks.push('fresh runtime prevents cross-run contamination');

  const blocked = await run({
    code: 'from js import fetch\ndef answer():\n    return 1',
    entryPoint: 'answer',
    cases: [caseFor('()', '1')],
  });
  assert.match(blocked.result.error, /ImportError/);
  checks.push('no default JS global access');

  const timed = await run({
    code: 'def answer():\n    while True:\n        pass',
    entryPoint: 'answer',
    cases: [caseFor('()', 'None')],
  });
  assert.match(timed.rejected, /4 seconds/);
  checks.push('four-second worker termination');

  const stopped = await page.evaluate(async () => {
    const started = new Promise((resolve) => {
      window.stopCheckStarted = resolve;
    });
    const promise = window.protocolTestRunner
      .run(
        {
          code: 'def answer():\n    while True:\n        pass',
          entryPoint: 'answer',
          cases: [{ name: 'Example', args: '()', expected: 'None' }],
        },
        (stage) => {
          if (stage === 'running') window.stopCheckStarted();
        },
      )
      .catch((error) => error.message);
    await started;
    window.protocolTestRunner.cancel();
    return promise;
  });
  assert.match(stopped, /stopped/);
  checks.push('explicit cancellation rejects and terminates the worker');

  response = await run({
    code: 'def answer():\n    return 5',
    entryPoint: 'answer',
    cases: [caseFor('()', '5')],
  });
  assert.equal(response.result.cases[0].passed, true);
  checks.push('new run works after timeout and cancellation');

  // A separate idle instance of the exact production worker gives these trusted
  // probes time to observe CSP events without modifying the runner protocol.
  // The route is defense in depth: if CSP regresses it aborts before any network
  // traffic, and its invocation makes this test fail (not falsely count as CSP).
  const probeTargets = [
    'http://127.0.0.1:5173/coding-practice-csp-probe',
    'https://example.com/coding-practice-csp-probe',
  ];
  const escapedRequests = [];
  for (const target of probeTargets) {
    await page.route(target, (route) => {
      escapedRequests.push(route.request().url());
      return route.abort('blockedbyclient');
    });
  }
  const runnerFrame = page
    .frames()
    .find((frame) => frame.url().startsWith('http://127.0.0.1:4174/runner.html'));
  assert(runnerFrame, 'The isolated runner iframe exists');
  const probeWorkerCreated = page.waitForEvent('worker', {
    predicate: (worker) => worker.url() === 'http://127.0.0.1:4174/worker.js',
  });
  await runnerFrame.evaluate(() => {
    window.cspProbeWorker = new Worker('/worker.js');
  });
  const probeWorker = await probeWorkerCreated;
  const networkProbe = await probeWorker.evaluate(async (targets) => {
    const violations = [];
    self.addEventListener('securitypolicyviolation', (event) =>
      violations.push({ directive: event.effectiveDirective, blockedURI: event.blockedURI }),
    );
    const results = await Promise.all(
      targets.map(async (url) => {
        try {
          await fetch(url, { credentials: 'omit' });
          return { url, allowed: true };
        } catch (error) {
          return { url, allowed: false, error: String(error) };
        }
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { results, violations };
  }, probeTargets);
  await runnerFrame.evaluate(() => {
    window.cspProbeWorker.terminate();
    delete window.cspProbeWorker;
  });
  assert.deepEqual(escapedRequests, [], 'CSP must block the requests before the fallback route');
  for (const target of probeTargets) {
    assert.equal(networkProbe.results.find((result) => result.url === target)?.allowed, false);
    assert(
      networkProbe.violations.some(
        (event) =>
          event.directive === 'connect-src' && event.blockedURI.startsWith(new URL(target).origin),
      ),
      `Missing CSP connect-src violation for ${target}: ${JSON.stringify(networkProbe)}`,
    );
  }
  checks.push('worker CSP blocks app-origin and external network access before any request');

  for (const exercise of catalog) {
    const reference = await run({
      code: exercise.referenceCode,
      entryPoint: exercise.entryPoint,
      cases: exercise.cases,
    });
    assert(
      !reference.rejected && !reference.result?.error,
      `${exercise.id} reference execution: ${JSON.stringify(reference)}`,
    );
    assert.equal(reference.result.cases.length, exercise.cases.length);
    assert(
      reference.result.cases.every((testCase) => testCase.passed === true),
      `${exercise.id} reference failures: ${JSON.stringify(reference.result.cases.filter((testCase) => !testCase.passed))}`,
    );
    const starter = await run({
      code: exercise.starterCode,
      entryPoint: exercise.entryPoint,
      cases: exercise.cases,
    });
    assert(
      !starter.rejected && !starter.result?.error,
      `${exercise.id} starter execution: ${JSON.stringify(starter)}`,
    );
    assert(
      starter.result.cases.some((testCase) => testCase.passed === false),
      `${exercise.id} accepted an unfinished starter`,
    );
    for (const alternative of exercise.solutionAlternatives ?? []) {
      const checked = await run({
        code: alternative.code,
        entryPoint: exercise.entryPoint,
        cases: exercise.cases,
      });
      assert(
        !checked.rejected && !checked.result?.error,
        `${exercise.id} alternative execution: ${JSON.stringify(checked)}`,
      );
      assert(
        checked.result.cases.every((testCase) => testCase.passed === true),
        `${exercise.id} alternative ${alternative.title} failures: ${JSON.stringify(checked.result.cases)}`,
      );
    }
    const wrong = await run({
      code: `def ${exercise.entryPoint}(*args):\n    return None`,
      entryPoint: exercise.entryPoint,
      cases: exercise.cases,
    });
    assert(
      !wrong.rejected && !wrong.result?.error,
      `${exercise.id} wrong-answer execution: ${JSON.stringify(wrong)}`,
    );
    assert(
      wrong.result.cases.some((testCase) => testCase.passed === false),
      `${exercise.id} accepted an always-None implementation`,
    );
    catalogChecks.push({
      id: exercise.id,
      referenceCasesPassed: reference.result.cases.length,
      starterRejected: true,
      alternativesPassed: exercise.solutionAlternatives?.length ?? 0,
      wrongNoneRejected: true,
    });
    console.log(
      `Verified ${exercise.id}: ${reference.result.cases.length} reference cases; wrong None rejected`,
    );
  }
  checks.push('all 15 reference solutions pass all 125 cases in real browser Pyodide');
  checks.push('all 15 always-None implementations fail behavioral grading');
  await page.evaluate(() => window.protocolTestRunner.dispose());
  assert.deepEqual(apiAttempts, [], 'Runner verification must not contact the data API');
  checks.push('isolated runner verification makes zero data API requests');
  console.log(JSON.stringify({ status: 'passed', checks, catalogChecks, networkProbe }, null, 2));
} finally {
  await browser.close();
}
