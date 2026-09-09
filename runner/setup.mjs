import { spawn } from 'node:child_process';
import { docker } from './execution.mjs';

for (const [file, image] of [
  ['runner/python/Dockerfile', 'cp-practice-python:2'],
  ['runner/javascript/Dockerfile', 'coding-practice-js:2'],
]) {
  const status = await new Promise((resolve, reject) => {
    const child = spawn(docker, ['build', '-f', file, '-t', image, '.'], {
      cwd: new URL('..', import.meta.url),
      windowsHide: true,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', resolve);
  });
  if (status !== 0) {
    process.exitCode = 1;
    break;
  }
}
