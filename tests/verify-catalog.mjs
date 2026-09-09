import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { docker, containerArguments } from '../runner/execution.mjs';
import { loadTestEnvironment } from './e2e/database-runtime.mjs';
import { readGradingSnapshot } from './grading-data.mjs';

const selection = process.argv[2] ?? 'python,sql,shell,browser-python';
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
if (status !== 0) process.exitCode = 1;
