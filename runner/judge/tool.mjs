import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tools = join(root, '.local', 'tools');
const bin = join(tools, 'bin');
const executable = join(root, 'build', process.platform === 'win32' ? 'judge.exe' : 'judge');
const environment = { ...process.env };
const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path');
const systemPath = environment[pathKey] ?? '';
if (pathKey) delete environment[pathKey];
environment.PATH = [join(tools, 'go', 'bin'), join(tools, 'protobuf', 'bin'), bin, systemPath].join(
  delimiter,
);

async function run(command, args, capture = false) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: environment,
      windowsHide: true,
      stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    process.on('SIGINT', interrupt);
    process.on('SIGTERM', terminate);
    const detach = () => {
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
    };
    let output = '';
    child.stdout?.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', () => {
      detach();
      reject(Error(`Cannot start ${command}. Install Go and protoc or use .local/tools.`));
    });
    child.once('exit', (code, signal) => {
      detach();
      if (code === 0) resolve(output);
      else reject(Error(`${command} stopped (${signal ?? code}).`));
    });
  });
}

async function build() {
  mkdirSync(join(root, 'build'), { recursive: true });
  await run('go', ['build', '-o', executable, './runner/judge']);
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
      await run(executable, []);
      break;
    case 'build':
      await build();
      break;
    case 'check': {
      const unformatted = await run('gofmt', ['-l', 'runner/judge'], true);
      if (unformatted.trim()) throw Error(`Run gofmt on:\n${unformatted.trim()}`);
      await run('go', ['vet', './runner/judge/...']);
      await build();
      break;
    }
    case 'generate':
      mkdirSync(bin, { recursive: true });
      environment.GOBIN = bin;
      await run('go', ['install', 'google.golang.org/protobuf/cmd/protoc-gen-go@v1.36.12']);
      await run('go', ['install', 'google.golang.org/grpc/cmd/protoc-gen-go-grpc@v1.6.2']);
      await run('protoc', [
        '-I',
        'runner/proto',
        '--go_out=.',
        '--go_opt=module=github.com/K23K-dev/corecode',
        '--go-grpc_out=.',
        '--go-grpc_opt=module=github.com/K23K-dev/corecode',
        'judge.proto',
      ]);
      await run(process.execPath, [
        'node_modules/@grpc/proto-loader/build/bin/proto-loader-gen-types.js',
        '--longs=String',
        '--enums=String',
        '--defaults',
        '--includeComments',
        '--grpcLib=@grpc/grpc-js',
        '--outDir=server/judge/gen',
        '--importFileExtension=.js',
        '-I',
        'runner/proto',
        '--',
        'judge.proto',
        'grpc/health/v1/health.proto',
      ]);
      await run(process.execPath, [
        'node_modules/prettier/bin/prettier.cjs',
        '--write',
        'server/judge/gen/**/*.ts',
      ]);
      break;
    default:
      throw Error('Use judge:dev, judge:build, judge:check, or judge:generate.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
