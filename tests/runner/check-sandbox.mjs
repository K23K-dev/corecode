// Explicit trusted verification only. Every code sample executes in a fresh managed sandbox.
// No environment files, catalog data, or database connections are used on the host.
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeSandboxProblem } from '../../runner/sandbox.mjs';

const VERSION = 'a'.repeat(64);
const SNAPSHOT_PATTERN = /^snap_[A-Za-z0-9_-]{1,180}$/;
const USAGE =
  'Usage: node tests/runner/check-sandbox.mjs --confirm-cloud-usage --snapshot snap_...';

export function parseSmokeArguments(args) {
  const snapshotFlag = args.indexOf('--snapshot');
  if (
    args.length !== 3 ||
    !args.includes('--confirm-cloud-usage') ||
    snapshotFlag < 0 ||
    !SNAPSHOT_PATTERN.test(args[snapshotFlag + 1] ?? '')
  ) {
    throw Error(USAGE);
  }
  return { confirmed: true, snapshotId: args[snapshotFlag + 1] };
}

const checks = [
  {
    id: 'runner-python-dependency-smoke',
    label: 'Python scientific, in-memory SQLite, and Bash utilities',
    code: 'class Solution:\n    def answer(self, value):\n        return value + 1\n',
    gradingSpec: {
      runtime: 'python',
      scientific: true,
      cases: [
        {
          name: 'Dependency smoke',
          expected: '42',
          code: [
            'import contextlib, shutil, sqlite3, subprocess',
            'assert solution.answer(41) == 42',
            'assert np.arange(3).sum() == 3',
            'assert pd.Series([1, 2]).sum() == 3',
            'assert torch.tensor([1, 2]).sum().item() == 3',
            'assert torch.get_num_threads() == 1',
            // SQLite is process-local and never opens a persistent database.
            "with contextlib.closing(sqlite3.connect(':memory:')) as connection:",
            "    assert connection.execute('SELECT 40 + 2').fetchone() == (42,)",
            "utilities = ('bash', 'cat', 'find', 'grep', 'sed', 'tar', 'gzip', 'jq', 'curl', 'ps', 'ss', 'ssh', 'less', 'man')",
            'assert all(shutil.which(tool) for tool in utilities)',
            "completed = subprocess.run(['bash', '--noprofile', '--norc', '-c', 'printf sandbox-smoke'], check=True, capture_output=True, text=True, timeout=3)",
            "assert completed.stdout == 'sandbox-smoke'",
            'actual = 42',
          ].join('\n'),
        },
      ],
    },
  },
  {
    id: 'runner-javascript-browser-smoke',
    label: 'JavaScript, esbuild, React imports, and Chromium',
    code: 'function answer(value) { return value + 1; }',
    gradingSpec: {
      runtime: 'javascript',
      syntax: 'javascript',
      entryPoint: 'answer',
      cases: [
        {
          name: 'Browser dependency smoke',
          input: '[41]',
          expected: '42',
          variant: 0,
          args: [41],
          value: 42,
        },
      ],
    },
  },
  {
    id: 'runner-python-wrong-answer-smoke',
    label: 'Wrong Python answer rejected',
    code: 'class Solution:\n    def answer(self, value):\n        return -1\n',
    rejectsAnswer: true,
    gradingSpec: {
      runtime: 'python',
      entryPoint: 'answer',
      cases: [{ name: 'Wrong answer', entryPoint: 'answer', args: '(41,)', expected: '42' }],
    },
  },
];

export async function runSmokeChecks({
  confirmed = false,
  snapshotId,
  execute = executeSandboxProblem,
  report = console.log,
} = {}) {
  if (confirmed !== true || typeof snapshotId !== 'string' || !SNAPSHOT_PATTERN.test(snapshotId)) {
    throw Error(USAGE);
  }

  for (const check of checks) {
    try {
      const result = await execute(
        {
          problemId: check.id,
          problemVersion: VERSION,
          code: check.code,
          mode: 'submit',
        },
        { id: check.id, version: VERSION, gradingSpec: check.gradingSpec },
        { snapshotId },
      );
      const testCase = result?.cases?.[0];
      const expectedOutcome = check.rejectsAnswer
        ? testCase?.passed === false && testCase.error === 'AssertionError: Returned -1'
        : testCase?.passed === true && testCase.actual === '42';
      if (
        result?.error ||
        !Array.isArray(result?.cases) ||
        result.cases.length !== 1 ||
        !expectedOutcome ||
        !Number.isFinite(result.durationMs) ||
        result.durationMs < 0
      ) {
        throw Error('Unexpected smoke result.');
      }
      const duration = Math.round(Math.min(result.durationMs, 60_000));
      report(`PASS ${check.label} (${duration} ms)`);
    } catch {
      // Never print SDK errors, connection details, stdout, or unchecked runner output.
      report(`FAIL ${check.label}`);
      throw Error('Hosted runner smoke verification failed. Connection details were not printed.');
    }
  }
  report('All 3 snapshot smoke checks passed. No catalog or persistent database was accessed.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let options;
  try {
    options = parseSmokeArguments(process.argv.slice(2));
  } catch {
    console.error(USAGE);
    process.exitCode = 1;
  }
  if (options) {
    try {
      await runSmokeChecks(options);
    } catch {
      console.error(
        'Hosted runner smoke verification failed. Connection details were not printed.',
      );
      process.exitCode = 1;
    }
  }
}
