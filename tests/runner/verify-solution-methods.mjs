// Trusted verification only: all submitted Python executes inside the restricted container.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { containerArguments, docker } from '../../runner/execution.mjs';

const name = 'cp-job-' + randomUUID();
const args = containerArguments('python', name);
args.splice(-1, 0, '--entrypoint', 'python');
args.push('/opt/runner/verify_solution_methods.py');
try {
  const result = spawnSync(docker, args, {
    windowsHide: true,
    encoding: 'utf8',
    timeout: 60_000,
    maxBuffer: 1_000_000,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  // Also remove this exact test container if Docker's client timed out before --rm could run.
  spawnSync(docker, ['rm', '-f', name], { windowsHide: true, stdio: 'ignore', timeout: 10_000 });
}
