import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { docker } from './execution.mjs';

const images = [
  ['runner/python/Dockerfile', 'cp-practice-python:2'],
  ['runner/javascript/Dockerfile', 'coding-practice-js:2'],
];
const setupAssets = Object.freeze([
  'runner/python/Dockerfile',
  'runner/python/entrypoint.py',
  'runner/python/shell_harness.py',
  'runner/javascript/Dockerfile',
  'runner/javascript/package.json',
  'runner/javascript/entrypoint.mjs',
  'runner/javascript/browser-checks.mjs',
  'runner/javascript/backend-checks.mjs',
  'tests/runner/python/verify_catalog.py',
  'tests/runner/python/verify_solution_methods.py',
]);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
// Current managed images use /vercel as their writable working directory.
const remoteRoot = '/vercel/code-practice-build';
const setupTimeoutMs = 30 * 60 * 1000;
const stopDockerCommand = [
  'set -eu',
  'pid=$(cat /var/run/docker.pid)',
  'case "$pid" in ""|*[!0-9]*) exit 1;; esac',
  '[ "$(cat /proc/"$pid"/comm)" = dockerd ]',
  'kill -TERM "$pid"',
  'for attempt in $(seq 1 60); do',
  'if ! kill -0 "$pid" 2>/dev/null; then sync; exit 0; fi',
  'sleep 0.5',
  'done',
  'exit 1',
].join('\n');

async function readSetupAsset(path) {
  const expected = resolve(projectRoot, path);
  const actual = await realpath(expected);
  const root = await realpath(projectRoot);
  // An allowlisted filename must not redirect the upload to .env or another file.
  if (actual !== resolve(root, path) || !actual.startsWith(root + sep)) {
    throw Error('A runner setup asset is not an ordinary project file.');
  }
  return readFile(actual);
}

export function parseSetupArguments(args) {
  if (args.length === 0) return { sandbox: false };
  if (
    args.length !== 2 ||
    new Set(args).size !== 2 ||
    !args.includes('--sandbox') ||
    !args.includes('--confirm-cloud-usage')
  ) {
    throw Error(
      'Remote setup uses your Vercel Sandbox quota. To authorize it, use --sandbox --confirm-cloud-usage. Run without arguments for local Docker.',
    );
  }
  return { sandbox: true };
}

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
    if (status !== 0) throw Error('The local runner image could not be built.');
  }
}

/** Explicit, trusted preparation only. Never called by startup or a learner request. */
export async function setupSandboxRunner({
  confirmed = false,
  sandboxClient,
  startDocker,
  readAsset = readSetupAsset,
  signal,
} = {}) {
  if (confirmed !== true) {
    throw Error('Confirm Vercel Sandbox quota usage before preparing the hosted runner.');
  }
  signal?.throwIfAborted();
  const files = await Promise.all(
    setupAssets.map(async (path) => ({
      path: remoteRoot + '/' + path,
      content: await readAsset(path),
      mode: 0o644,
    })),
  );
  if (
    files.some((file) => !Buffer.isBuffer(file.content)) ||
    files.reduce((bytes, file) => bytes + file.content.length, 0) > 2 * 1024 * 1024
  ) {
    throw Error('Runner setup assets are invalid or exceed the 2 MiB upload limit.');
  }
  const client = sandboxClient ?? (await import('@vercel/sandbox')).Sandbox;
  const initializeDocker = startDocker ?? (await import('./sandbox.mjs')).startSandboxDocker;
  const deadline = AbortSignal.timeout(setupTimeoutMs);
  const operation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const name = 'cp-runner-setup-' + randomUUID();
  let sandbox;
  let snapshotId;
  let failed = false;

  async function command(cmd, args, timeoutMs) {
    operation.throwIfAborted();
    const result = await sandbox.runCommand({
      cmd,
      args,
      cwd: remoteRoot,
      sudo: true,
      timeoutMs,
      signal: operation,
    });
    if (result.exitCode !== 0) throw Error('A trusted setup command did not finish.');
  }

  try {
    operation.throwIfAborted();
    sandbox = await client.create({
      name,
      image: 'vercel/sandbox/universal',
      persistent: false,
      resources: { vcpus: 2 },
      timeout: setupTimeoutMs,
      networkPolicy: 'allow-all',
      ports: [],
      signal: operation,
    });
    // No environment variables, source archive, database data, or credentials are sent.
    for (const path of [remoteRoot, remoteRoot + '/runner', remoteRoot + '/tests']) {
      await sandbox.mkDir(path, { signal: operation });
    }
    for (const directory of [
      'runner/python',
      'runner/javascript',
      'tests/runner',
      'tests/runner/python',
    ]) {
      await sandbox.mkDir(remoteRoot + '/' + directory, { signal: operation });
    }
    await sandbox.writeFiles(files, { signal: operation });
    await command(
      'sed',
      ['-i', 's|http://|https://|g', '/etc/apt/sources.list.d/ubuntu.sources'],
      10_000,
    );
    await command('apt-get', ['-o', 'Acquire::ForceIPv4=true', 'update'], 5 * 60 * 1000);
    await command(
      'apt-get',
      ['-o', 'Acquire::ForceIPv4=true', 'install', '-y', '--no-install-recommends', 'docker.io'],
      5 * 60 * 1000,
    );
    await initializeDocker(sandbox, operation);
    for (const [file, image] of images) {
      await command(
        'docker',
        ['build', '--network=host', '-f', file, '-t', image, '.'],
        15 * 60 * 1000,
      );
    }
    // Snapshot only clean dependency images, never a learner run or its private specification.
    await command('sh', ['-c', stopDockerCommand], 35_000);
    await sandbox.update({ networkPolicy: 'deny-all' }, { signal: operation });
    const snapshot = await sandbox.snapshot({ expiration: 0, signal: operation });
    if (!/^snap_[A-Za-z0-9_-]{1,180}$/.test(snapshot.snapshotId ?? '')) {
      throw Error('The snapshot identifier is invalid.');
    }
    snapshotId = snapshot.snapshotId;
    return snapshotId;
  } catch {
    failed = true;
    // SDK errors may include request or credential details. Never echo them.
    throw Error(
      'Hosted runner preparation did not finish. Check Vercel Sandbox access, quota, and setup logs before retrying. Connection details were not printed.',
    );
  } finally {
    const cleanupSignal = AbortSignal.timeout(10_000);
    if (!sandbox) {
      // Creation can fail after the remote resource exists; recover only our exact UUID name.
      sandbox = await client.get({ name, resume: false, signal: cleanupSignal }).catch(() => null);
    }
    if (sandbox) {
      try {
        await sandbox.delete({ deleteOrphanSnapshots: !snapshotId, signal: cleanupSignal });
      } catch {
        await sandbox.stop({ signal: AbortSignal.timeout(5_000) }).catch(() => {});
        if (!failed) {
          throw Error(
            'The runner snapshot was created, but setup cleanup could not be confirmed. Check the Vercel Sandbox dashboard before retrying.',
          );
        }
      }
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseSetupArguments(process.argv.slice(2));
    if (options.sandbox) {
      const snapshotId = await setupSandboxRunner({ confirmed: true });
      console.log('RUNNER_SANDBOX_SNAPSHOT=' + snapshotId);
      console.log('Verify the graders with this snapshot before enabling it in production.');
    } else {
      await setupLocalRunner();
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
