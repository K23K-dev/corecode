import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseSetupArguments, setupSandboxRunner } from '../../runner/setup.mjs';

// All cloud operations are mocked. This suite never starts Docker or creates a Sandbox.
function fixture(overrides = {}) {
  const calls = [];
  const record =
    (method, result) =>
    async (...args) => {
      calls.push({ method, args });
      if (overrides[method]) return overrides[method](...args);
      return result;
    };
  const sandbox = {
    mkDir: record('mkDir'),
    writeFiles: record('writeFiles'),
    runCommand: record('runCommand', { exitCode: 0 }),
    update: record('update'),
    snapshot: record('snapshot', { snapshotId: 'snap_trusted_runner' }),
    delete: record('delete'),
    stop: record('stop'),
  };
  const sandboxClient = {
    create: record('create', sandbox),
    get: record('get', sandbox),
  };
  const readPaths = [];
  const options = {
    confirmed: true,
    sandboxClient,
    startDocker: record('startDocker'),
    readAsset: async (path) => {
      readPaths.push(path);
      return Buffer.from('trusted fixture asset');
    },
  };
  return { calls, sandbox, sandboxClient, readPaths, options };
}

describe('trusted hosted-runner preparation', () => {
  it('retains local setup by default and requires both explicit remote flags', () => {
    assert.deepEqual(parseSetupArguments([]), { sandbox: false });
    assert.deepEqual(parseSetupArguments(['--sandbox', '--confirm-cloud-usage']), {
      sandbox: true,
    });
    for (const args of [
      ['--sandbox'],
      ['--confirm-cloud-usage'],
      ['--sandbox', '--sandbox'],
      ['--sandbox', '--confirm-cloud-usage', '--other'],
    ]) {
      assert.throws(() => parseSetupArguments(args), /authorize/);
    }
  });

  it('does not even read assets or call the SDK without confirmation', async () => {
    const context = fixture();
    await assert.rejects(setupSandboxRunner({ ...context.options, confirmed: false }), /Confirm/);
    assert.deepEqual(context.calls, []);
    assert.deepEqual(context.readPaths, []);
  });

  it('rejects an already canceled setup before upload or creation', async () => {
    const context = fixture();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(setupSandboxRunner({ ...context.options, signal: controller.signal }));
    assert.deepEqual(context.calls, []);
  });

  it('uploads only required allowlisted assets, never a repository, env, or grading data', async () => {
    const context = fixture();
    assert.equal(await setupSandboxRunner(context.options), 'snap_trusted_runner');
    assert.deepEqual(context.readPaths, [
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
    const create = context.calls.find((call) => call.method === 'create').args[0];
    assert.match(create.name, /^cp-runner-setup-[a-f0-9-]{36}$/);
    assert.equal(create.image, 'vercel/sandbox/universal');
    assert.equal(create.persistent, false);
    assert.equal(create.timeout, 30 * 60 * 1000);
    assert.deepEqual(create.resources, { vcpus: 2 });
    assert.deepEqual(create.ports, []);
    assert.equal(create.env, undefined);
    assert.equal(create.source, undefined);
    const upload = context.calls.find((call) => call.method === 'writeFiles').args[0];
    assert.equal(upload.length, 10);
    for (const file of upload) {
      assert.ok(file.path.startsWith('/vercel/code-practice-build/'));
      assert.equal(file.mode, 0o644);
      assert.ok(Buffer.isBuffer(file.content));
    }
  });

  it('creates the current-image build directories in order before uploading files', async () => {
    const context = fixture();
    await setupSandboxRunner(context.options);
    const directories = [
      '/vercel/code-practice-build',
      '/vercel/code-practice-build/runner',
      '/vercel/code-practice-build/tests',
      '/vercel/code-practice-build/runner/python',
      '/vercel/code-practice-build/runner/javascript',
      '/vercel/code-practice-build/tests/runner',
      '/vercel/code-practice-build/tests/runner/python',
    ];
    const uploadIndex = context.calls.findIndex((call) => call.method === 'writeFiles');
    assert.equal(context.calls[0].method, 'create');
    assert.deepEqual(
      context.calls
        .slice(1, uploadIndex)
        .map((call) => ({ method: call.method, path: call.args[0] })),
      directories.map((path) => ({ method: 'mkDir', path })),
    );
    assert.equal(
      context.calls.filter((call) => call.method === 'mkDir').length,
      directories.length,
    );
    assert.ok(uploadIndex < context.calls.findIndex((call) => call.method === 'runCommand'));
  });

  it('builds the exact images remotely with host networking and stops Docker before snapshot', async () => {
    const context = fixture();
    await setupSandboxRunner(context.options);
    const commands = context.calls
      .filter((call) => call.method === 'runCommand')
      .map((call) => call.args[0]);
    assert.deepEqual(commands[0].args, [
      '-i',
      's|http://|https://|g',
      '/etc/apt/sources.list.d/ubuntu.sources',
    ]);
    assert.equal(commands[0].cmd, 'sed');
    assert.deepEqual(
      commands.filter(({ cmd }) => cmd === 'apt-get').map(({ cmd, args }) => ({ cmd, args })),
      [
        { cmd: 'apt-get', args: ['-o', 'Acquire::ForceIPv4=true', 'update'] },
        {
          cmd: 'apt-get',
          args: [
            '-o',
            'Acquire::ForceIPv4=true',
            'install',
            '-y',
            '--no-install-recommends',
            'docker.io',
          ],
        },
      ],
    );
    assert.deepEqual(
      commands.filter(({ cmd }) => cmd === 'docker').map(({ args }) => args),
      [
        [
          'build',
          '--network=host',
          '-f',
          'runner/python/Dockerfile',
          '-t',
          'cp-practice-python:2',
          '.',
        ],
        [
          'build',
          '--network=host',
          '-f',
          'runner/javascript/Dockerfile',
          '-t',
          'coding-practice-js:2',
          '.',
        ],
      ],
    );
    for (const command of commands) {
      assert.equal(command.cwd, '/vercel/code-practice-build');
      assert.equal(command.sudo, true);
      assert.ok(command.timeoutMs > 0);
      assert.equal(command.env, undefined);
    }
    const stop = commands.at(-1);
    assert.equal(stop.cmd, 'sh');
    assert.match(stop.args[1], /\/var\/run\/docker\.pid/);
    assert.match(stop.args[1], /kill -TERM/);
    assert.match(stop.args[1], /seq 1 60/);
    assert.match(stop.args[1], /sync/);
    const methods = context.calls.map((call) => call.method);
    assert.ok(methods.indexOf('startDocker') < methods.lastIndexOf('runCommand'));
    assert.deepEqual(methods.slice(-3), ['update', 'snapshot', 'delete']);
    assert.deepEqual(context.calls.at(-3).args[0], { networkPolicy: 'deny-all' });
    assert.equal(context.calls.at(-2).args[0].expiration, 0);
    assert.equal(context.calls.at(-1).args[0].deleteOrphanSnapshots, false);
  });

  it('sanitizes setup errors and removes only the failed builder with an independent signal', async () => {
    const controller = new AbortController();
    const context = fixture({
      runCommand: async () => {
        controller.abort();
        throw Error('postgresql://secret.example token=private');
      },
    });
    await assert.rejects(
      setupSandboxRunner({ ...context.options, signal: controller.signal }),
      (error) =>
        /preparation did not finish/.test(error.message) && !/secret|token=/.test(error.message),
    );
    const cleanup = context.calls.find((call) => call.method === 'delete').args[0];
    assert.equal(cleanup.deleteOrphanSnapshots, true);
    assert.notEqual(cleanup.signal, controller.signal);
    assert.equal(cleanup.signal.aborted, false);
    assert.ok(!context.calls.some((call) => call.method === 'snapshot'));
  });

  it('cleans up the exact generated name after uncertain creation failure', async () => {
    const context = fixture({
      create: async () => {
        throw Error('private SDK error');
      },
    });
    await assert.rejects(setupSandboxRunner(context.options), /preparation did not finish/);
    const createdName = context.calls.find((call) => call.method === 'create').args[0].name;
    assert.equal(context.calls.find((call) => call.method === 'get').args[0].name, createdName);
    assert.equal(context.calls.at(-1).method, 'delete');
    assert.equal(context.calls.at(-1).args[0].deleteOrphanSnapshots, true);
  });

  it('does not snapshot when a trusted build command fails', async () => {
    const context = fixture({ runCommand: async () => ({ exitCode: 1 }) });
    await assert.rejects(setupSandboxRunner(context.options), /preparation did not finish/);
    assert.ok(!context.calls.some((call) => call.method === 'snapshot'));
    assert.equal(context.calls.at(-1).args[0].deleteOrphanSnapshots, true);
  });

  it('does not build or snapshot when trusted Docker initialization fails', async () => {
    const context = fixture({
      startDocker: async () => {
        throw Error('private initialization failure');
      },
    });
    await assert.rejects(setupSandboxRunner(context.options), /preparation did not finish/);
    assert.ok(context.calls.some((call) => call.method === 'startDocker'));
    assert.ok(
      !context.calls.some((call) => call.method === 'runCommand' && call.args[0].cmd === 'docker'),
    );
    assert.ok(!context.calls.some((call) => ['update', 'snapshot'].includes(call.method)));
    assert.equal(context.calls.at(-1).method, 'delete');
    assert.equal(context.calls.at(-1).args[0].deleteOrphanSnapshots, true);
  });

  it('reports cleanup failure without deleting a successful trusted snapshot', async () => {
    const context = fixture({
      delete: async () => {
        throw Error('private SDK error');
      },
    });
    await assert.rejects(setupSandboxRunner(context.options), /cleanup could not be confirmed/);
    assert.equal(
      context.calls.find((call) => call.method === 'delete').args[0].deleteOrphanSnapshots,
      false,
    );
    assert.equal(context.calls.at(-1).method, 'stop');
  });

  it('rejects oversized assets before allocating cloud resources', async () => {
    const context = fixture();
    await assert.rejects(
      setupSandboxRunner({ ...context.options, readAsset: async () => Buffer.alloc(300_000) }),
      /2 MiB/,
    );
    assert.deepEqual(context.calls, []);
  });
});
