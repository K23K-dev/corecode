import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { Sandbox } from '@vercel/sandbox';
import { sandboxCredentials } from '../../server/judge/sandbox.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const namePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;

async function buildJudge() {
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, ['runner/judge/tool.mjs', 'build-linux'], {
      cwd: root,
      windowsHide: true,
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? done() : reject(new Error('Judge build failed.'))));
  });
}

async function uploadFiles(box) {
  // Only reviewed runtime files are uploaded; no .env, catalog, or learner data.
  for (const directory of ['runner/python', 'runner/javascript']) {
    for (const entry of await readdir(resolve(root, directory), {
      recursive: true,
      withFileTypes: true,
    })) {
      if (
        !entry.isFile() ||
        /(?:^|[/\\])(?:node_modules|__pycache__)(?:[/\\]|$)/.test(entry.parentPath)
      )
        continue;
      if (!/\.(?:py|mjs|json)$/.test(entry.name) && entry.name !== 'Dockerfile') continue;
      const path = resolve(entry.parentPath, entry.name);
      await box.writeFiles([
        {
          path: `/opt/corecode/${relative(root, path).replaceAll('\\', '/')}`,
          content: await readFile(path),
        },
      ]);
    }
  }
  await box.writeFiles([
    {
      path: '/opt/corecode/judge',
      content: await readFile(resolve(root, 'build/judge-linux-amd64')),
    },
    {
      path: '/opt/corecode/boot.sh',
      content: Buffer.from(
        (await readFile(resolve(root, 'runner/sandbox/boot.sh'), 'utf8')).replaceAll('\r\n', '\n'),
      ),
    },
  ]);
}

/** Prepare one persistent Docker/image store; this does not connect to Neon. */
export async function setupSandbox({ name, credentials = sandboxCredentials() }) {
  if (!namePattern.test(name ?? '')) throw new Error('Set JUDGE_SANDBOX_NAME to a lowercase name.');
  await buildJudge();
  let box;
  const command = async (cmd, args, timeoutMs = 180_000) => {
    const result = await box.runCommand({ cmd, args, sudo: true, timeoutMs });
    if (result.exitCode !== 0) {
      // Setup has no credentials in the VM, so package/build output is safe here.
      console.error((await result.stderr()).slice(-4000));
      throw new Error(`Sandbox setup failed while running ${cmd}.`);
    }
    return result;
  };
  try {
    // Creating an existing name fails. Never replace a queue's engine implicitly.
    box = await Sandbox.create({
      ...credentials,
      name,
      image: 'vercel/sandbox/universal',
      ports: [8080],
      resources: { vcpus: 2 },
      timeout: 30 * 60_000,
      persistent: false,
      snapshotExpiration: 0,
      keepLastSnapshots: { count: 1, expiration: 0, deleteEvicted: true },
    });
    console.log('Preparing Docker and the Go judge in Vercel Sandbox.');
    await command('sh', [
      '-c',
      'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-buildx',
    ]);
    await command('sh', ['-c', 'mkdir -p /opt/corecode && chmod 777 /opt/corecode']);
    await uploadFiles(box);
    await command('sh', ['-c', 'chown -R root:root /opt/corecode && chmod 755 /opt/corecode']);
    await command('chmod', ['700', '/opt/corecode/judge', '/opt/corecode/boot.sh']);
    await command('/opt/corecode/boot.sh', ['--prepare']);
    for (const [path, tag] of [
      ['python', 'cp-practice-python:2'],
      ['javascript', 'coding-practice-js:2'],
    ]) {
      console.log(`Building the ${path} runtime.`);
      await command(
        'docker',
        ['build', '-f', `/opt/corecode/runner/${path}/Dockerfile`, '-t', tag, '/opt/corecode'],
        15 * 60_000,
      );
    }
    await command('sh', [
      '-c',
      'pkill -TERM -x dockerd; for attempt in $(seq 1 15); do pgrep -x dockerd >/dev/null || exit 0; sleep 1; done; exit 1',
    ]);
    await box.update({ persistent: true });
    await box.stop();
    await box.update({ timeout: 240_000 });
    console.log(
      `Prepared ${name}. Configure the same JUDGE_SANDBOX_NAME and JUDGE_TOKEN in both website environments.`,
    );
    return { name, snapshotId: box.currentSnapshotId };
  } catch (error) {
    if (box) {
      await box.update({ persistent: false }).catch(() => {});
      await box.stop().catch(() => {});
      await box.delete({ deleteOrphanSnapshots: true }).catch(() => {});
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (existsSync(resolve(root, '.env'))) loadEnvFile(resolve(root, '.env'));
  if (existsSync(resolve(root, '.env.local'))) loadEnvFile(resolve(root, '.env.local'));
  try {
    await setupSandbox({ name: process.env.JUDGE_SANDBOX_NAME });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
