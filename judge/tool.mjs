import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const judge = join(root, 'judge');
const tools = join(root, '.local', 'tools');
const bin = join(tools, 'bin');
const executable = join(root, 'build', process.platform === 'win32' ? 'judge.exe' : 'judge');
const environment = { ...process.env };
const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path');
const systemPath = environment[pathKey] ?? '';
if (pathKey) delete environment[pathKey];
environment.PATH = [join(tools, 'go', 'bin'), bin, systemPath].join(delimiter);

/** Runs a command with the portable Go tools on PATH; `capture` returns its stdout. */
function run(command, args, { cwd = root, capture = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      windowsHide: true,
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve(output);
      else reject(Error(`${command} stopped (${signal ?? code}).`));
    });
  });
}

async function build(target = executable) {
  mkdirSync(join(root, 'build'), { recursive: true });
  await run('go', ['build', '-o', target, '.'], { cwd: judge });
}

try {
  switch (process.argv[2]) {
    case 'build':
      await build();
      break;
    case 'build-linux':
      Object.assign(environment, { GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' });
      await build(join(root, 'build', 'judge-linux-amd64'));
      break;
    case 'images': {
      const windowsDockerPath = 'C:/Program Files/Docker/Docker/resources/bin/docker.exe';
      const docker =
        process.platform === 'win32' && existsSync(windowsDockerPath)
          ? windowsDockerPath
          : 'docker';
      for (const [file, image] of [
        ['judge/graders/python/Dockerfile', 'cp-practice-python:3'],
        ['judge/graders/javascript/Dockerfile', 'coding-practice-js:4'],
      ]) {
        await run(docker, ['build', '-f', file, '-t', image, '.']);
      }
      break;
    }
    case 'check': {
      const unformatted = await run('gofmt', ['-l', 'judge'], { capture: true });
      if (unformatted.trim()) throw Error(`Run gofmt on:\n${unformatted.trim()}`);
      await run('go', ['vet', './...'], { cwd: judge });
      await build();
      break;
    }
    case 'generate':
      mkdirSync(bin, { recursive: true });
      environment.GOBIN = bin;
      await run('go', ['install', 'google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.12'], {
        cwd: judge,
      });
      await run('go', ['install', 'connectrpc.com/connect/cmd/protoc-gen-connect-go@v1.21.0'], {
        cwd: judge,
      });
      // Go gets the judge service only; the standard health service comes from grpchealth.
      const goPlugin = (name, ...options) => ({
        local: join(bin, `protoc-gen-${name}${process.platform === 'win32' ? '.exe' : ''}`),
        out: 'judge',
        opt: ['module=github.com/K23K-dev/corecode/judge', ...options],
        types: ['corecode.judge.v1.JudgeService'],
      });
      await run(process.execPath, [
        'node_modules/@bufbuild/buf/bin/buf',
        'generate',
        'proto',
        '--template',
        JSON.stringify({
          version: 'v2',
          plugins: [
            goPlugin('go'),
            goPlugin('connect-go', 'simple'),
            {
              local: [process.execPath, 'node_modules/@bufbuild/protoc-gen-es/bin/protoc-gen-es'],
              out: 'src/server/judge-client/gen',
              opt: 'target=ts',
            },
          ],
        }),
      ]);
      await run(process.execPath, [
        'node_modules/prettier/bin/prettier.cjs',
        '--write',
        'src/server/judge-client/gen/**/*.ts',
      ]);
      break;
    default:
      throw Error('Use judge:build, judge:check, judge:generate, judge:images, or build-linux.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
