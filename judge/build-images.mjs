import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const windowsDockerPath = 'C:/Program Files/Docker/Docker/resources/bin/docker.exe';
const docker =
  process.platform === 'win32' && existsSync(windowsDockerPath) ? windowsDockerPath : 'docker';
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const images = [
  ['judge/graders/python/Dockerfile', 'cp-practice-python:2'],
  ['judge/graders/javascript/Dockerfile', 'coding-practice-js:2'],
];

try {
  for (const [file, image] of images) {
    const status = await new Promise((done, reject) => {
      const child = spawn(docker, ['build', '-f', file, '-t', image, '.'], {
        cwd: projectRoot,
        windowsHide: true,
        stdio: 'inherit',
      });
      child.once('error', reject);
      child.once('exit', done);
    });
    if (status !== 0) throw Error('The grading image could not be built.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
