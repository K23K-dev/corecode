import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const windowsDockerPath = 'C:/Program Files/Docker/Docker/resources/bin/docker.exe';
const docker =
  process.platform === 'win32' && existsSync(windowsDockerPath) ? windowsDockerPath : 'docker';
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const images = [
  ['runner/python/Dockerfile', 'cp-practice-python:2'],
  ['runner/javascript/Dockerfile', 'coding-practice-js:2'],
];

export async function setupLocalRunner() {
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
    if (status !== 0) throw Error('The runner image could not be built.');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 2)
      throw Error('Run runner:setup without arguments on the judge host.');
    await setupLocalRunner();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
