import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { loadEnvFile } from 'node:process';
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

async function run(command, args, { cwd = root, capture = false, parentStdin = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: environment,
      windowsHide: true,
      stdio: parentStdin
        ? ['pipe', 'inherit', 'inherit']
        : capture
          ? ['ignore', 'pipe', 'inherit']
          : 'inherit',
    });
    let shutdownTimer;
    const stop = (signal) => {
      if (parentStdin) {
        child.stdin.end();
        shutdownTimer ??= setTimeout(() => child.kill('SIGKILL'), 35_000);
      } else child.kill(signal);
    };
    child.stdin?.on('error', () => {});
    const interrupt = () => stop('SIGINT');
    const terminate = () => stop('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const detach = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
      clearTimeout(shutdownTimer);
    };
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', () => {
      detach();
      reject(Error(`Cannot start ${command}. Install Go or use .local/tools/go.`));
    });
    child.once('exit', (code, signal) => {
      detach();
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
    case 'dev':
      await build();
      if (existsSync(join(root, '.env'))) loadEnvFile(join(root, '.env'));
      // Inherit the private environment only for the judge, not generation/build tools.
      for (const [key, value] of Object.entries(process.env)) {
        if (key.toLowerCase() !== 'path') environment[key] = value;
      }
      await run(executable, ['--parent-stdin'], { parentStdin: true });
      break;
    case 'build':
      await build();
      break;
    case 'build-linux':
      Object.assign(environment, { GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '0' });
      await build(join(root, 'build', 'judge-linux-amd64'));
      break;
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
      await run('go', ['install', 'google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.6.2'], {
        cwd: judge,
      });
      await run(process.execPath, [
        'node_modules/@bufbuild/buf/bin/buf',
        'generate',
        'proto',
        '--template',
        JSON.stringify({
          version: 'v2',
          plugins: [
            ...['go', 'go-grpc'].map((plugin) => ({
              local: join(bin, `protoc-gen-${plugin}${process.platform === 'win32' ? '.exe' : ''}`),
              out: 'judge',
              opt: 'module=github.com/K23K-dev/corecode/judge',
              types: ['corecode.judge.v1.JudgeService'],
            })),
            {
              local: [process.execPath, 'node_modules/@bufbuild/protoc-gen-es/bin/protoc-gen-es'],
              out: 'src/server/judge/gen',
              opt: 'target=ts',
            },
          ],
        }),
      ]);
      await run(process.execPath, [
        'node_modules/prettier/bin/prettier.cjs',
        '--write',
        'src/server/judge/gen/**/*.ts',
      ]);
      break;
    default:
      throw Error('Use judge:dev, judge:build, judge:check, judge:generate, or build-linux.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
