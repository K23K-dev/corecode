import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { docker, containerArguments, prepareExecution } from '../runner/execution.mjs';
import { executeSandboxProblem } from '../runner/sandbox.mjs';
import { loadTestEnvironment } from './e2e/database-runtime.mjs';
import { readGradingSnapshot } from './grading-data.mjs';
import { RequestError } from '../server/validation.mjs';

const RUNTIMES = ['python', 'sql', 'shell', 'javascript', 'browser-python'];
const SNAPSHOT = /^snap_[A-Za-z0-9_-]{1,180}$/;
const SANDBOX_START_INTERVAL_MS = 3_500;
const USAGE =
  'Usage: node tests/verify-catalog.mjs --sandbox --confirm-cloud-usage --snapshot snap_... [--runtimes python,sql,shell,javascript,browser-python] [--limit 1..1000] [--plan]';
const RESERVED_NAMES = new Set(
  (
    'False None True and as assert async await break class continue def del elif else except ' +
    'finally for from global if import in is lambda nonlocal not or pass raise return try while ' +
    'with yield case catch const debugger default delete do enum export extends function ' +
    'implements instanceof interface let new null package private protected public static super ' +
    'switch this throw typeof var void true false'
  ).split(' '),
);
const safeEntryPoint = (name) =>
  typeof name === 'string' &&
  /^[A-Za-z][A-Za-z0-9_]*$/.test(name) &&
  name !== 'Solution' &&
  !RESERVED_NAMES.has(name);

function checkedSandboxOptions(options) {
  if (
    options?.sandbox !== true ||
    options.confirmed !== true ||
    typeof options.snapshotId !== 'string' ||
    !SNAPSHOT.test(options.snapshotId) ||
    !Array.isArray(options.runtimes) ||
    !options.runtimes.length ||
    new Set(options.runtimes).size !== options.runtimes.length ||
    options.runtimes.some((runtime) => !RUNTIMES.includes(runtime)) ||
    (options.limit !== undefined &&
      (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 1000)) ||
    typeof options.plan !== 'boolean'
  ) {
    throw Error(USAGE);
  }
  return options;
}

export function parseCatalogArguments(args) {
  if (!args.includes('--sandbox')) {
    if (args.length > 1 || args[0]?.startsWith('--')) throw Error(USAGE);
    const selection = args[0] ?? 'python,sql,shell,browser-python';
    if (
      selection
        .split(',')
        .some((runtime) => !RUNTIMES.filter((r) => r !== 'javascript').includes(runtime))
    ) {
      throw Error(USAGE);
    }
    return { sandbox: false, selection };
  }
  const options = { sandbox: true, confirmed: false, runtimes: [...RUNTIMES], plan: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (seen.has(flag)) throw Error(USAGE);
    seen.add(flag);
    if (flag === '--sandbox') continue;
    if (flag === '--confirm-cloud-usage') options.confirmed = true;
    else if (flag === '--plan') options.plan = true;
    else if (['--snapshot', '--runtimes', '--limit'].includes(flag)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw Error(USAGE);
      if (flag === '--snapshot') options.snapshotId = value;
      if (flag === '--runtimes') options.runtimes = value.split(',');
      if (flag === '--limit') {
        if (!/^[1-9]\d{0,3}$/.test(value)) throw Error(USAGE);
        options.limit = Number(value);
      }
    } else throw Error(USAGE);
  }
  return checkedSandboxOptions(options);
}

function wrongAnswerVariant(problem, spec) {
  const name = spec.entryPoint ?? spec.cases[0]?.entryPoint;
  if (!safeEntryPoint(name)) return null;
  if (
    spec.runtime === 'python' &&
    spec.cases.every(
      (test) =>
        !Object.hasOwn(test, 'code') && typeof test.args === 'string' && test.entryPoint === name,
    )
  ) {
    return {
      variant: 'wrong-answer',
      mode: 'submit',
      code: `class Solution:\n    def ${name}(self, *args, **kwargs):\n        return object()\n`,
      mismatch: /^AssertionError: Returned <object object at 0x[0-9a-f]+>$/,
    };
  }
  if (
    spec.runtime === 'javascript' &&
    spec.syntax === 'javascript' &&
    !problem.id.startsWith('backend-') &&
    spec.cases.every(
      (test) =>
        Array.isArray(test.args) && Object.hasOwn(test, 'value') && test.value !== undefined,
    )
  ) {
    return {
      variant: 'wrong-answer',
      mode: 'submit',
      code: `function ${name}() { return undefined; }`,
      mismatch: /\bUnexpected result: expected [^\n]+, received undefined(?:\n|$)/,
    };
  }
  return null;
}

export function createSandboxCatalogPlan(rows, options) {
  checkedSandboxOptions(options);
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000) {
    throw Error('The current catalog is empty or exceeds the 1000-problem verification limit.');
  }
  const matching = rows.filter(({ problem }) => options.runtimes.includes(problem.runtime));
  const selected = options.limit ? matching.slice(0, options.limit) : matching;
  if (!selected.length) throw Error('No current problems match the selected runtimes.');
  const wrongFamilies = new Set();
  const entries = selected.map(({ problem, spec }) => {
    if (
      typeof problem.id !== 'string' ||
      problem.id.length > 200 ||
      !Array.isArray(spec?.cases) ||
      !spec.cases.length ||
      !Array.isArray(problem.solutionAlternatives ?? [])
    )
      throw Error('The current catalog cannot be safely verified.');
    const executionProblem = { id: problem.id, version: problem.version, gradingSpec: spec };
    const variants = [
      { variant: 'reference', mode: 'submit', code: problem.referenceCode },
      ...(problem.solutionAlternatives ?? []).map((alternative, index) => ({
        variant: `alternative-${index + 1}`,
        mode: 'submit',
        code: alternative.code,
      })),
    ];
    variants.push({ variant: 'starter', mode: 'submit', code: problem.starterCode });
    const wrong = wrongAnswerVariant(problem, spec);
    const family = problem.runtime;
    if (wrong && !wrongFamilies.has(family)) {
      wrongFamilies.add(family);
      variants.push(wrong);
    }
    for (const variant of variants) {
      // This validates/serializes strings only. It never executes candidate code on the host.
      prepareExecution(
        { problemId: problem.id, problemVersion: problem.version, ...variant },
        executionProblem,
      );
    }
    return { problem, executionProblem, variants };
  });
  const jobs = entries.reduce((count, entry) => count + entry.variants.length, 0);
  if (jobs > 10000) throw Error('The catalog exceeds the 10000-job verification limit.');
  return { entries, jobs, totalProblems: rows.length, matchingProblems: matching.length };
}

function classifyCatalogResult(result, variant, expectedCases) {
  const cases = result?.cases;
  if (
    result?.error ||
    !Array.isArray(cases) ||
    cases.length !== expectedCases ||
    !Number.isFinite(result.durationMs) ||
    result.durationMs < 0
  )
    return 'invalid-runner-result';
  if (cases.some((test) => typeof test?.passed !== 'boolean')) return 'invalid-runner-result';
  if (
    cases.some(
      (test) =>
        typeof test.error === 'string' &&
        /Target (?:page, context or browser has been closed|closed|crashed)|Page crashed|browserContext\.|browserType\.|Protocol error|Connection closed|ENOMEM/i.test(
          test.error,
        ),
    )
  ) {
    return 'runner-infrastructure-error';
  }
  if (variant.variant === 'wrong-answer') {
    return cases.every((test) => test.passed === false && variant.mismatch.test(test.error ?? ''))
      ? null
      : 'wrong-answer-not-rejected';
  }
  if (variant.variant === 'starter') {
    return cases.some((test) => test.passed === false) ? null : 'starter-accepted';
  }
  return cases.every((test) => test.passed === true && !test.error) ? null : 'reference-mismatch';
}

export async function verifySandboxCatalog(
  options,
  {
    loadEnvironment = loadTestEnvironment,
    readSnapshot = readGradingSnapshot,
    execute = executeSandboxProblem,
    report = console.log,
    now = () => performance.now(),
    delay = sleep,
  } = {},
) {
  checkedSandboxOptions(options); // Consent and bounds precede even private environment loading.
  let plan;
  try {
    loadEnvironment();
    // Existing reader validates Neon/SSL and both digests, uses one repeatable-read READ ONLY
    // transaction, and closes its pool before returning. No learner state/submissions are read.
    plan = createSandboxCatalogPlan(await readSnapshot(), options);
  } catch {
    throw Error(
      'Could not prepare read-only catalog verification. Private details were not printed.',
    );
  }
  const summary = {
    snapshotId: options.snapshotId,
    totalProblems: plan.totalProblems,
    matchingProblems: plan.matchingProblems,
    selectedProblems: plan.entries.length,
    plannedJobs: plan.jobs,
    completedJobs: 0,
    passedJobs: 0,
    failedJobs: 0,
    nativeBrowserProblems: plan.entries.filter(
      ({ problem }) => problem.runtime === 'browser-python',
    ).length,
    results: [],
  };
  report(
    JSON.stringify({
      event: 'plan',
      ...summary,
      results: undefined,
      concurrency: 2,
      readOnly: true,
    }),
  );
  if (options.plan) return { ...summary, status: 'planned' };
  let cursor = 0;
  let stopped = false;
  let nextStart = -Infinity;
  let launchQueue = Promise.resolve();
  function scheduleExecution(start) {
    const scheduled = launchQueue.then(async () => {
      if (stopped) return null;
      // Share one creation gate across both workers. Each VM requests two vCPUs;
      // spacing starts also respects the provider's allocation rate limit.
      while (now() < nextStart) await delay(nextStart - now());
      if (stopped) return null;
      nextStart = now() + SANDBOX_START_INTERVAL_MS;
      // Release the launch queue without waiting for the actual run to finish.
      return { pending: start() };
    });
    launchQueue = scheduled.then(
      () => {},
      () => {},
    );
    return scheduled;
  }
  async function worker() {
    while (!stopped && cursor < plan.entries.length) {
      const entry = plan.entries[cursor++];
      for (const variant of entry.variants) {
        if (stopped) break;
        let result;
        let failure;
        let executionCode;
        try {
          const scheduled = await scheduleExecution(() =>
            execute(
              {
                problemId: entry.problem.id,
                problemVersion: entry.problem.version,
                mode: variant.mode,
                code: variant.code,
              },
              entry.executionProblem,
              { snapshotId: options.snapshotId },
            ),
          );
          if (!scheduled) break;
          result = await scheduled.pending;
          failure = classifyCatalogResult(
            result,
            variant,
            entry.executionProblem.gradingSpec.cases.length,
          );
        } catch (error) {
          failure = 'execution-or-cleanup-error';
          // Only our fixed public error codes are safe to persist, never raw SDK errors.
          if (
            error instanceof RequestError &&
            [
              'runner_startup_failed',
              'runner_unavailable',
              'runner_cleanup_failed',
              'runner_stopped',
              'runner_busy',
              'runner_not_configured',
              'grading_unavailable',
              'invalid_runner_result',
            ].includes(error.code)
          )
            executionCode = error.code;
        }
        const outcome = {
          id: entry.problem.id,
          version: entry.problem.version,
          runtime: entry.problem.runtime,
          variant: variant.variant,
          status: failure ? 'failed' : 'passed',
          cases: Array.isArray(result?.cases) ? Math.min(result.cases.length, 32) : 0,
          ...(failure ? { failure } : {}),
          ...(executionCode ? { executionCode } : {}),
        };
        summary.results.push(outcome);
        summary.completedJobs++;
        if (failure) {
          summary.failedJobs++;
          stopped = true;
        } else summary.passedJobs++;
        report(JSON.stringify({ event: 'result', completed: summary.completedJobs, ...outcome }));
      }
    }
  }
  // A failing worker stops new jobs; await the one already-running sibling and its cleanup.
  await Promise.all([worker(), worker()]);
  const status = !stopped && summary.completedJobs === summary.plannedJobs ? 'passed' : 'failed';
  const final = { ...summary, status, unrunJobs: summary.plannedJobs - summary.completedJobs };
  report(JSON.stringify({ event: 'summary', ...final, results: undefined }));
  return final;
}

async function verifyLocalCatalog(selection) {
  const runtimes = selection.split(',');
  if (runtimes.some((runtime) => !['python', 'sql', 'shell', 'browser-python'].includes(runtime))) {
    throw Error(
      'Choose python, sql, shell, or browser-python. This verifier does not support JavaScript.',
    );
  }
  loadTestEnvironment();
  const jobs = (await readGradingSnapshot())
    .filter(({ problem }) => runtimes.includes(problem.runtime))
    .map(({ problem, spec }) => ({
      ...problem,
      protocolVersion: 2,
      problemVersion: problem.version,
      spec,
    }));
  if (!jobs.length) throw Error('No current Neon problems match the selected runtimes.');
  const name = 'cp-job-' + randomUUID();
  const args = containerArguments('python', name);
  args.splice(-1, 0, '--entrypoint', 'python');
  args.push('/opt/runner/verify_catalog.py');
  const child = spawn(docker, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '',
    errors = '';
  const timer = setTimeout(() => {
    spawn(docker, ['rm', '-f', name], { windowsHide: true, stdio: 'ignore' });
    child.kill();
  }, 300000);
  child.stdout.on('data', (c) => {
    output += c;
    if (output.length > 1000000) child.kill();
  });
  child.stderr.on('data', (c) => {
    if (errors.length < 16000) errors += c;
  });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(jobs));
  const status = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  clearTimeout(timer);
  let report;
  try {
    report = JSON.parse(output);
  } catch {
    throw Error(`Verification container failed (${status}): ${errors.slice(0, 3000)}`);
  }
  fs.mkdirSync('tests/test-results', { recursive: true });
  fs.writeFileSync('tests/test-results/catalog-python.json', JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify(
      {
        ...report,
        failures: report.failures.map((f) => ({
          id: f.id,
          variant: f.variant,
          cases: f.result.cases.filter((c) => !c.passed),
        })),
      },
      null,
      2,
    ),
  );
  return status !== 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseCatalogArguments(process.argv.slice(2));
  } catch {
    console.error(USAGE);
    process.exitCode = 1;
  }
  if (options) {
    try {
      if (options.sandbox) {
        const report = await verifySandboxCatalog(options);
        if (report.status !== 'planned') {
          const directory = new URL('./test-results/', import.meta.url);
          fs.mkdirSync(directory, { recursive: true });
          fs.writeFileSync(
            new URL('catalog-sandbox.json', directory),
            JSON.stringify(report, null, 2),
          );
        }
        if (report.status === 'failed') process.exitCode = 1;
      } else if (await verifyLocalCatalog(options.selection)) process.exitCode = 1;
    } catch {
      console.error(
        'Catalog verification did not finish. Private connection and grading details were not printed.',
      );
      process.exitCode = 1;
    }
  }
}
