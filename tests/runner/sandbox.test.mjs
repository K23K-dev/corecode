import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { containerArguments } from '../../runner/execution.mjs';
import { executeSandboxProblem } from '../../runner/sandbox.mjs';

// Every execution injects this in-memory SDK double. No learner code, cloud
// commands, Docker processes, database access, or snapshot creation occurs.
const ID = 'sandbox-fixture';
const VERSION = 'a'.repeat(64);
const SNAPSHOT = 'snap_offline_fixture';
const gradingSpec = {
  runtime: 'python',
  entryPoint: 'answer',
  cases: [
    { name: 'Positive', args: '(1,)', expected: '2' },
    { name: 'Zero', args: '(0,)', expected: '1' },
    { name: 'Negative', args: '(-1,)', expected: '0' },
  ],
};
const problem = { id: ID, version: VERSION, gradingSpec };
const request = (overrides = {}) => ({
  problemId: ID,
  problemVersion: VERSION,
  code: 'def answer(value):\n    return value + 1\n',
  mode: 'example',
  ...overrides,
});
const result = (count = 1) => ({
  cases: Array.from({ length: count }, (_, index) => ({
    name: `case ${index}`,
    input: 'example',
    expected: 'valid result',
    actual: 'valid result',
    passed: true,
  })),
  stdout: '',
  durationMs: 1.25,
});
const errorWith = (status, code, pattern) => (error) => {
  assert.equal(error.status, status);
  assert.equal(error.code, code);
  if (pattern) assert.match(error.message, pattern);
  return true;
};

function deferred() {
  let resolve;
  const promise = new Promise((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function waitForAbort(signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => {
      clearTimeout(guard);
      reject(signal.reason);
    };
    // AbortSignal.timeout is unref'ed. This bounded guard both keeps the mock
    // alive until cancellation and turns a missing signal into a useful failure.
    const guard = setTimeout(() => {
      signal.removeEventListener('abort', aborted);
      reject(new Error('The SDK mock did not receive cancellation.'));
    }, 1_000);
    if (signal.aborted) aborted();
    else signal.addEventListener('abort', aborted, { once: true });
  });
}

function fixture(hooks = {}) {
  const calls = {
    creates: [],
    gets: [],
    commands: [],
    writes: [],
    logs: [],
    waits: [],
    deletes: [],
    stops: [],
    cleanup: [],
    snapshots: [],
  };
  const created = deferred();
  const streaming = deferred();
  const command = {
    async *logs(options) {
      calls.logs.push(options);
      streaming.resolve();
      if (hooks.logs) yield* hooks.logs(options);
      else yield { stream: 'stdout', data: JSON.stringify(hooks.result ?? result()) };
    },
    async wait(options) {
      calls.waits.push(options);
      if (hooks.wait) return hooks.wait(options);
      return { exitCode: 0 };
    },
    stdout() {
      assert.fail('Learner output must be streamed, never aggregated by the SDK.');
    },
    output() {
      assert.fail('Learner output must be streamed, never aggregated by the SDK.');
    },
  };
  const sandbox = {
    async runCommand(options) {
      calls.commands.push(options);
      if (hooks.runCommand) return hooks.runCommand(options, calls.commands.length, command);
      return options.detached ? command : { exitCode: 0 };
    },
    async writeFiles(files, options) {
      calls.writes.push({ files, options });
      if (hooks.writeFiles) return hooks.writeFiles(files, options);
    },
    async delete(options) {
      calls.cleanup.push('delete');
      calls.deletes.push(options);
      if (hooks.delete) return hooks.delete(options);
    },
    async stop(options) {
      calls.cleanup.push('stop');
      calls.stops.push(options);
      if (hooks.stop) return hooks.stop(options);
      return { status: 'stopped' };
    },
    async snapshot(options) {
      calls.snapshots.push(options);
      assert.fail('Learner executions must never create reusable snapshots.');
    },
  };
  const sandboxClient = {
    async create(options) {
      calls.creates.push(options);
      created.resolve();
      if (hooks.create) return hooks.create(options, sandbox);
      return sandbox;
    },
    async get(options) {
      calls.gets.push(options);
      if (hooks.get) return hooks.get(options, sandbox);
      throw Object.assign(new Error('Fixture sandbox was not allocated.'), {
        response: { status: 404 },
      });
    },
  };
  return {
    calls,
    sandbox,
    created: created.promise,
    streaming: streaming.promise,
    run: (body = request(), selected = problem, options = {}) =>
      executeSandboxProblem(body, selected, { sandboxClient, snapshotId: SNAPSHOT, ...options }),
  };
}

describe('hosted sandbox execution boundary', { concurrency: false }, () => {
  it('validates requests, identity, private specs, and snapshot configuration before creation', async () => {
    const run = fixture();
    for (const body of [null, [], 'command', 1]) {
      await assert.rejects(run.run(body), errorWith(400, 'invalid_request'));
    }
    await assert.rejects(run.run(request(), null), errorWith(404, 'invalid_request'));
    await assert.rejects(
      run.run(request({ problemVersion: 'b'.repeat(64) })),
      errorWith(409, 'problem_changed'),
    );
    for (const body of [
      request({ code: 'a'.repeat(32_769) }),
      request({ code: '界'.repeat(17_067) }),
      request({ mode: 'unlimited' }),
      request({ mode: 'custom', customArgs: 'x'.repeat(8_193) }),
    ]) {
      await assert.rejects(run.run(body), errorWith(400, 'invalid_request'));
    }
    for (const spec of [null, {}, { ...gradingSpec, runtime: 'ubuntu:latest' }]) {
      await assert.rejects(
        run.run(request({ spec: gradingSpec, gradingSpec }), { ...problem, gradingSpec: spec }),
        errorWith(503, 'grading_unavailable'),
      );
    }
    for (const snapshotId of [null, '', 'other-snapshot', 'snap_../private', 'snap_']) {
      await assert.rejects(
        run.run(request(), problem, { snapshotId }),
        errorWith(503, 'runner_not_configured'),
      );
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      run.run(request(), problem, { signal: controller.signal }),
      errorWith(503, 'runner_stopped'),
    );
    assert.equal(run.calls.creates.length, 0);
    assert.equal(run.calls.gets.length, 0);
  });

  it('transports only the exact private protocol-v2 payload through a fixed input file', async () => {
    const run = fixture();
    const code = 'print("literal ; & $(whoami) 🐍")\n';
    const body = request({
      code,
      mode: 'custom',
      customArgs: '([1, 3], 3)',
      runtime: 'javascript',
      image: 'evil-image',
      mounts: ['/private:/host'],
      env: { POSTGRES_URL: 'counterfeit connection', VERCEL_TOKEN: 'counterfeit token' },
      network: 'host',
      privileged: true,
      containerName: 'user-container',
      cases: [],
      spec: { runtime: 'javascript', cases: [] },
      gradingSpec: { runtime: 'shell', cases: [] },
      snapshotId: 'snap_counterfeit',
      protocolVersion: 1,
      entryPoint: 'counterfeit',
      expected: 'accepted',
      timeoutMs: 0,
    });
    assert.deepEqual(await run.run(body), result());
    assert.equal(run.calls.writes.length, 1);
    const [{ files, options }] = run.calls.writes;
    assert.equal(files.length, 1);
    assert.equal(files[0].path, '/tmp/code-practice-request.json');
    assert.ok(Buffer.isBuffer(files[0].content));
    assert.deepEqual(JSON.parse(files[0].content.toString('utf8')), {
      protocolVersion: 2,
      problemId: ID,
      problemVersion: VERSION,
      spec: gradingSpec,
      code,
      mode: 'custom',
      customArgs: '([1, 3], 3)',
    });
    assert.ok(options.signal instanceof AbortSignal);
    assert.ok(!JSON.stringify(run.calls.creates).includes('counterfeit'));
    assert.ok(!JSON.stringify(run.calls.commands).includes(code));
    assert.ok(!JSON.stringify(run.calls.commands).includes('counterfeit'));
  });

  it('uses fresh nonpersistent VMs without network, ports, or injected environment', async () => {
    const run = fixture();
    await run.run();
    await run.run();
    assert.equal(run.calls.creates.length, 2);
    const names = new Set();
    for (const options of run.calls.creates) {
      assert.match(options.name, /^cp-job-[a-f0-9-]{36}$/);
      names.add(options.name);
      assert.deepEqual(Object.keys(options).sort(), [
        'name',
        'networkPolicy',
        'persistent',
        'ports',
        'resources',
        'signal',
        'source',
        'timeout',
      ]);
      assert.deepEqual(options.source, { type: 'snapshot', snapshotId: SNAPSHOT });
      assert.equal(options.persistent, false);
      assert.equal(options.networkPolicy, 'deny-all');
      assert.deepEqual(options.ports, []);
      assert.deepEqual(options.resources, { vcpus: 2 });
      assert.equal(options.timeout, 90_000);
      assert.ok(options.signal instanceof AbortSignal);
    }
    assert.equal(names.size, 2);
    assert.equal(run.calls.deletes.length, 2);
    assert.equal(run.calls.stops.length, 2);
    assert.deepEqual(run.calls.cleanup, ['stop', 'delete', 'stop', 'delete']);
    assert.equal(run.calls.snapshots.length, 0);
    assert.equal(run.calls.gets.length, 0);
  });

  it('runs only fixed setup text and the same hardened inner-container arguments for every runtime', async () => {
    for (const runtime of ['python', 'sql', 'shell', 'javascript']) {
      const run = fixture();
      await run.run(request(), { ...problem, gradingSpec: { ...gradingSpec, runtime } });
      assert.equal(run.calls.commands.length, 2);
      const [setup, job] = run.calls.commands;
      assert.equal(setup.cmd, 'sh');
      assert.equal(setup.cwd, '/vercel');
      assert.equal(job.cwd, '/vercel');
      assert.equal(setup.args.length, 2);
      assert.equal(setup.args[0], '-c');
      assert.match(setup.args[1], /^mkdir -p \/vercel\/sandbox \|\| exit 1; /);
      assert.match(setup.args[1], /nohup dockerd --host=unix:\/\/\/var\/run\/docker\.sock /);
      const initialization = setup.args[1].slice(0, setup.args[1].indexOf('nohup dockerd'));
      assert.ok(initialization.includes('test -f /sys/fs/cgroup/cgroup.controllers || exit 1; '));
      assert.ok(initialization.includes('mkdir -p /sys/fs/cgroup/code-practice-init || exit 1; '));
      assert.ok(initialization.includes('cgroups_ready=0; for attempt in $(seq 1 20); do '));
      const migration =
        'xargs -rn1 < /sys/fs/cgroup/cgroup.procs > /sys/fs/cgroup/code-practice-init/cgroup.procs';
      const controllers =
        'if printf "+cpu +memory +pids\\n" > /sys/fs/cgroup/cgroup.subtree_control; ';
      assert.ok(initialization.includes(migration));
      assert.ok(initialization.includes(controllers));
      assert.ok(initialization.indexOf(migration) < initialization.indexOf(controllers));
      assert.ok(initialization.includes('then cgroups_ready=1; break; fi; sleep 0.1; done; '));
      assert.ok(initialization.endsWith('test "$cgroups_ready" -eq 1 || exit 1; '));
      assert.doesNotMatch(initialization, /\b(?:while|until)\b/);
      assert.match(
        setup.args[1],
        /--iptables=false --bridge=none --ip-forward=false --ip-masq=false/,
      );
      assert.ok(setup.args[1].includes('for attempt in $(seq 1 250); do '));
      assert.equal(setup.sudo, true);
      assert.equal(setup.timeoutMs, 30_000);
      assert.equal(job.cmd, 'sh');
      assert.deepEqual(job.args, [
        '-c',
        'exec docker "$@" < /tmp/code-practice-request.json',
        'code-practice',
        ...containerArguments(runtime, run.calls.creates[0].name),
      ]);
      assert.equal(job.sudo, true);
      assert.equal(job.detached, true);
      assert.equal(job.timeoutMs, 20_000);
      assert.equal(job.signal, setup.signal);
      assert.equal(run.calls.logs[0].signal, job.signal);
      assert.equal(run.calls.waits[0].signal, job.signal);
      assert.equal(run.calls.writes[0].options.signal, job.signal);
      assert.equal(run.calls.deletes[0].deleteOrphanSnapshots, true);
      assert.notEqual(run.calls.deletes[0].signal, job.signal);
      assert.notEqual(run.calls.stops[0].signal, job.signal);
      assert.notEqual(run.calls.stops[0].signal, run.calls.deletes[0].signal);
      assert.deepEqual(run.calls.cleanup, ['stop', 'delete']);
    }
  });

  it('uses the private submission case count and never forwards unused custom input', async () => {
    const run = fixture({ result: result(3) });
    assert.equal(
      (await run.run(request({ mode: 'submit', customArgs: 'ignored' }))).cases.length,
      3,
    );
    const payload = JSON.parse(run.calls.writes[0].files[0].content.toString());
    assert.equal(Object.hasOwn(payload, 'customArgs'), false);
    assert.deepEqual(payload.spec, gradingSpec);
  });

  it('waits for the exact created handle after browser cancellation, then stops and deletes it', async () => {
    const gate = deferred();
    const run = fixture({
      create: async (options, sandbox) => {
        await gate.promise;
        return sandbox;
      },
    });
    const controller = new AbortController();
    const pending = run.run(request(), problem, { signal: controller.signal });
    const rejected = assert.rejects(pending, errorWith(503, 'runner_stopped', /canceled/));
    await run.created;
    controller.abort();
    assert.equal(run.calls.creates[0].signal.aborted, false);
    assert.equal(run.calls.deletes.length, 0);
    gate.resolve();
    await rejected;
    assert.equal(run.calls.commands.length, 0);
    assert.equal(run.calls.writes.length, 0);
    assert.equal(run.calls.deletes.length, 1);
    assert.equal(run.calls.deletes[0].signal.aborted, false);
    assert.equal(run.calls.stops.length, 1);
  });

  it('cancels a streamed run with a fresh cleanup signal and does not consume a late result', async () => {
    const controller = new AbortController();
    const run = fixture({
      logs: async function* ({ signal }) {
        yield { stream: 'stderr', data: 'private diagnostic' };
        await waitForAbort(signal);
        yield { stream: 'stdout', data: JSON.stringify(result()) };
      },
    });
    const pending = run.run(request(), problem, { signal: controller.signal });
    const rejected = assert.rejects(pending, errorWith(503, 'runner_stopped', /canceled/));
    await run.streaming;
    controller.abort();
    await rejected;
    assert.equal(run.calls.waits.length, 0);
    assert.equal(run.calls.deletes.length, 1);
    assert.equal(run.calls.deletes[0].signal.aborted, false);
    assert.notEqual(run.calls.deletes[0].signal, controller.signal);
    controller.abort();
    assert.equal(run.calls.deletes.length, 1);
  });

  it('applies a deadline to creation without accepting a request-supplied timeout', async () => {
    const run = fixture({ create: ({ signal }) => waitForAbort(signal) });
    await assert.rejects(
      run.run(request({ timeoutMs: 0 }), problem, { timeoutMs: 5 }),
      errorWith(503, 'runner_stopped', /timed out/),
    );
    assert.equal(run.calls.creates[0].timeout, 90_000);
    assert.equal(run.calls.creates[0].signal.aborted, true);
    assert.equal(run.calls.deletes.length, 0);
    assert.deepEqual(await fixture().run(), result());
  });

  it('stops a timed-out log stream and cleans up its exact sandbox', async () => {
    const run = fixture({
      logs: async function* ({ signal }) {
        await waitForAbort(signal);
      },
    });
    await assert.rejects(
      run.run(request(), problem, { timeoutMs: 5 }),
      errorWith(503, 'runner_stopped', /timed out/),
    );
    assert.equal(run.calls.deletes.length, 1);
    assert.equal(run.calls.waits.length, 0);
    assert.equal(run.calls.stops.length, 1);
  });

  it('bounds combined stdout and stderr bytes and stops reading immediately on overflow', async () => {
    for (const stream of ['stdout', 'stderr']) {
      let continued = false;
      const run = fixture({
        logs: async function* () {
          yield { stream: 'stdout', data: 'x'.repeat(256_000) };
          yield { stream, data: 'x'.repeat(256_001) };
          continued = true;
          yield { stream: 'stdout', data: JSON.stringify(result()) };
        },
      });
      await assert.rejects(run.run(), errorWith(503, 'runner_stopped', /too much output/));
      assert.equal(continued, false);
      assert.equal(run.calls.waits.length, 0);
      assert.equal(run.calls.deletes.length, 1);
    }
    const unicode = fixture({
      logs: async function* () {
        yield { stream: 'stderr', data: '界'.repeat(170_667) };
      },
    });
    await assert.rejects(unicode.run(), errorWith(503, 'runner_stopped', /too much output/));
    assert.equal(unicode.calls.deletes.length, 1);
  });

  it('accepts exactly the output byte limit while keeping stderr out of result parsing', async () => {
    const diagnostic = 'private diagnostic';
    const encoded = JSON.stringify(result());
    const run = fixture({
      logs: async function* () {
        yield { stream: 'stderr', data: diagnostic };
        yield { stream: 'stdout', data: encoded.slice(0, 12) };
        yield {
          stream: 'stdout',
          data: encoded.slice(12).padEnd(512_000 - diagnostic.length - 12, ' '),
        };
      },
    });
    assert.deepEqual(await run.run(), result());
    assert.equal(run.calls.waits.length, 1);
    assert.equal(run.calls.deletes.length, 1);
  });

  it('sanitizes SDK errors at every stage and always cleans up acquired handles', async () => {
    const fail = () => {
      throw new Error('secret credential and database URL');
    };
    const stages = {
      create: { create: fail },
      setup: { runCommand: fail },
      write: { writeFiles: fail },
      run: { runCommand: (options, index, command) => (index === 1 ? { exitCode: 0 } : fail()) },
      stream: {
        logs: async function* () {
          fail();
        },
      },
      wait: { wait: fail },
    };
    for (const [stage, hooks] of Object.entries(stages)) {
      const run = fixture(hooks);
      await assert.rejects(run.run(), (error) => {
        assert.equal(error.status, 503);
        assert.equal(error.code, 'runner_unavailable');
        assert.doesNotMatch(error.message, /secret|credential|database URL/);
        return true;
      });
      assert.equal(run.calls.deletes.length, stage === 'create' ? 0 : 1);
      assert.equal(run.calls.snapshots.length, 0);
    }
    assert.deepEqual(await fixture().run(), result());
  });

  it('recovers only its own named handle after a lost creation response without resuming it', async () => {
    const run = fixture({
      create: async () => {
        throw new Error('Private create response was lost after allocation.');
      },
      get: async (options, sandbox) => sandbox,
    });
    await assert.rejects(run.run(), errorWith(503, 'runner_unavailable'));
    assert.equal(run.calls.creates.length, 1);
    assert.equal(run.calls.gets.length, 1);
    const [lookup] = run.calls.gets;
    assert.deepEqual(Object.keys(lookup).sort(), ['name', 'resume', 'signal']);
    assert.equal(lookup.name, run.calls.creates[0].name);
    assert.equal(lookup.resume, false);
    assert.ok(lookup.signal instanceof AbortSignal);
    assert.equal(lookup.signal.aborted, false);
    assert.notEqual(lookup.signal, run.calls.creates[0].signal);
    assert.equal(run.calls.commands.length, 0);
    assert.equal(run.calls.writes.length, 0);
    assert.equal(run.calls.deletes.length, 1);
    assert.equal(run.calls.deletes[0].deleteOrphanSnapshots, true);
    assert.equal(run.calls.stops.length, 1);
    assert.equal(run.calls.snapshots.length, 0);
  });

  it('still recovers and deletes its own allocation after a creation deadline expires', async () => {
    const run = fixture({
      create: ({ signal }) => waitForAbort(signal),
      get: async (options, sandbox) => sandbox,
    });
    await assert.rejects(
      run.run(request(), problem, { timeoutMs: 5 }),
      errorWith(503, 'runner_stopped', /timed out/),
    );
    assert.equal(run.calls.gets.length, 1);
    assert.equal(run.calls.gets[0].name, run.calls.creates[0].name);
    assert.equal(run.calls.gets[0].resume, false);
    assert.equal(run.calls.gets[0].signal.aborted, false);
    assert.equal(run.calls.commands.length, 0);
    assert.equal(run.calls.deletes.length, 1);
    assert.equal(run.calls.deletes[0].signal.aborted, false);
  });

  it('keeps failed recovery lookups private and releases capacity without touching other sandboxes', async () => {
    const run = fixture({
      create: async () => {
        throw new Error('Private creation token');
      },
      get: async () => {
        throw new Error('Private lookup token');
      },
    });
    await assert.rejects(run.run(), (error) => {
      assert.equal(error.code, 'runner_unavailable');
      assert.doesNotMatch(error.message, /Private|token/);
      return true;
    });
    assert.equal(run.calls.gets.length, 1);
    assert.equal(run.calls.gets[0].name, run.calls.creates[0].name);
    assert.equal(run.calls.gets[0].resume, false);
    assert.equal(run.calls.deletes.length, 0);
    assert.equal(run.calls.stops.length, 0);
    assert.equal(run.calls.snapshots.length, 0);
    assert.deepEqual(await fixture().run(), result());
  });

  it('rejects unsuccessful setup and container exits without exposing diagnostics', async () => {
    for (const [hooks, code] of [
      [{ runCommand: async () => ({ exitCode: 1 }) }, 'runner_startup_failed'],
      [{ wait: async () => ({ exitCode: 125 }) }, 'runner_unavailable'],
    ]) {
      const run = fixture(hooks);
      await assert.rejects(run.run(), errorWith(503, code));
      assert.equal(run.calls.deletes.length, 1);
      assert.equal(run.calls.stops.length, 1);
    }
  });

  it('never uploads a request or launches a container after trusted initialization fails', async () => {
    const run = fixture({ runCommand: async () => ({ exitCode: 1 }) });
    await assert.rejects(run.run(), errorWith(503, 'runner_startup_failed', /could not start/));
    assert.equal(run.calls.commands.length, 1);
    assert.equal(run.calls.commands[0].cwd, '/vercel');
    assert.equal(run.calls.commands[0].detached, undefined);
    assert.deepEqual(run.calls.writes, []);
    assert.deepEqual(run.calls.logs, []);
    assert.deepEqual(run.calls.waits, []);
    assert.deepEqual(run.calls.snapshots, []);
    assert.equal(run.calls.deletes.length, 1);
    assert.equal(run.calls.deletes[0].deleteOrphanSnapshots, true);
    assert.equal(run.calls.stops.length, 1);
  });

  it('rejects invalid result JSON, shapes, and private suite counts without accepting the run', async () => {
    for (const value of [
      'not-json',
      'null',
      '{}',
      JSON.stringify({ ...result(), durationMs: '1' }),
      JSON.stringify(result(0)),
      JSON.stringify(result(2)),
    ]) {
      const run = fixture({
        logs: async function* () {
          yield { stream: 'stdout', data: value };
        },
      });
      await assert.rejects(run.run(), errorWith(503, 'invalid_runner_result'));
      assert.equal(run.calls.deletes.length, 1);
    }
    const submission = fixture();
    await assert.rejects(
      submission.run(request({ mode: 'submit' })),
      errorWith(503, 'invalid_runner_result'),
    );
  });

  it('returns genuine grading errors as errors rather than accepted cases', async () => {
    const value = { cases: [], durationMs: 0, stdout: '', error: 'SyntaxError: invalid syntax' };
    const run = fixture({ result: value });
    assert.deepEqual(await run.run(), value);
    assert.equal(run.calls.deletes.length, 1);
  });

  it('accepts only confirmed terminal stops and always deletes after an unconfirmed stop', async (context) => {
    const timeouts = [];
    const originalTimeout = AbortSignal.timeout;
    context.mock.method(AbortSignal, 'timeout', (duration) => {
      timeouts.push(duration);
      return originalTimeout(duration);
    });
    for (const status of ['stopped', 'failed']) {
      const run = fixture({ stop: async () => ({ status }) });
      assert.deepEqual(await run.run(), result());
      assert.deepEqual(run.calls.cleanup, ['stop', 'delete']);
      assert.deepEqual(timeouts.splice(0), [90_000, 15_000, 5_000]);
    }
    for (const returned of [undefined, null, {}, { status: 'running' }, { status: 'stopping' }]) {
      const run = fixture({ stop: async () => returned });
      await assert.rejects(run.run(), errorWith(503, 'runner_cleanup_failed'));
      assert.deepEqual(run.calls.cleanup, ['stop', 'stop', 'delete']);
      assert.deepEqual(timeouts.splice(0), [90_000, 15_000, 15_000, 5_000]);
    }
    const run = fixture({
      stop: async () => {
        throw new Error('private credential postgres://secret');
      },
    });
    await assert.rejects(run.run(), (error) => {
      errorWith(503, 'runner_cleanup_failed')(error);
      assert.doesNotMatch(error.message + JSON.stringify(error), /private|credential|postgres/i);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.deepEqual(run.calls.cleanup, ['stop', 'stop', 'delete']);
    assert.deepEqual(timeouts.splice(0), [90_000, 15_000, 15_000, 5_000]);
    assert.deepEqual(await fixture().run(), result());
  });

  it('retries a timed-out stop with a fresh deadline without repeating learner execution', async (context) => {
    const controllers = [];
    const durations = [];
    const originalTimeout = AbortSignal.timeout;
    context.mock.method(AbortSignal, 'timeout', (duration) => {
      durations.push(duration);
      if (duration !== 15_000) return originalTimeout(duration);
      const controller = new AbortController();
      controllers.push(controller);
      return controller.signal;
    });
    const run = fixture({
      stop: async ({ signal }) => {
        if (controllers.length === 1) {
          const stopped = waitForAbort(signal);
          controllers[0].abort(new DOMException('private timeout details', 'TimeoutError'));
          await stopped;
        }
        return { status: 'stopped' };
      },
    });
    assert.deepEqual(await run.run(), result());
    assert.deepEqual(durations, [90_000, 15_000, 15_000, 5_000]);
    assert.deepEqual(run.calls.cleanup, ['stop', 'stop', 'delete']);
    assert.equal(run.calls.creates.length, 1);
    assert.equal(run.calls.commands.length, 2);
    assert.equal(run.calls.writes.length, 1);
    assert.equal(run.calls.logs.length, 1);
    assert.equal(run.calls.waits.length, 1);
    assert.equal(run.calls.deletes.length, 1);
    const [first, second] = run.calls.stops;
    assert.equal(first.signal.aborted, true);
    assert.equal(second.signal.aborted, false);
    assert.notEqual(first.signal, second.signal);
    assert.notEqual(first.signal, run.calls.deletes[0].signal);
    assert.notEqual(second.signal, run.calls.deletes[0].signal);
  });

  it('confirms a nonterminal stop once more and stops retrying on either terminal state', async () => {
    for (const status of ['stopped', 'failed']) {
      let attempts = 0;
      const run = fixture({
        stop: async () => ({ status: ++attempts === 1 ? 'stopping' : status }),
      });
      assert.deepEqual(await run.run(), result());
      assert.deepEqual(run.calls.cleanup, ['stop', 'stop', 'delete']);
      assert.equal(run.calls.creates.length, 1);
      assert.equal(run.calls.commands.length, 2);
    }
  });

  it('maps only SDK creation rate limits to a sanitized busy response without retrying', async () => {
    const failure = (status = 429, code = 'rate_limit_exceeded') =>
      Object.assign(new Error('private credential postgres://secret'), {
        response: { status },
        json: { error: { code, message: 'private service response' } },
      });
    const run = fixture({
      create: async () => {
        throw failure();
      },
    });
    await assert.rejects(run.run(), (error) => {
      errorWith(429, 'runner_busy')(error);
      assert.doesNotMatch(error.message + JSON.stringify(error), /private|credential|postgres/i);
      assert.equal(error.cause, undefined);
      return true;
    });
    assert.equal(run.calls.creates.length, 1);
    assert.equal(run.calls.gets.length, 1);
    assert.equal(run.calls.gets[0].name, run.calls.creates[0].name);
    assert.equal(run.calls.gets[0].resume, false);
    assert.deepEqual(run.calls.commands, []);
    assert.deepEqual(run.calls.cleanup, []);
    for (const hooks of [
      {
        create: async () => {
          throw failure(503);
        },
      },
      {
        create: async () => {
          throw failure(429, 'other_error');
        },
      },
      {
        runCommand: async () => {
          throw failure();
        },
      },
    ]) {
      const other = fixture(hooks);
      await assert.rejects(other.run(), errorWith(503, 'runner_unavailable'));
      assert.equal(other.calls.creates.length, 1);
    }
    assert.deepEqual(await fixture().run(), result());
  });

  it('reports unconfirmed deletion after stopping and never returns success', async () => {
    for (const stopFails of [false, true]) {
      const run = fixture({
        delete: async () => {
          throw new Error('private deletion failure');
        },
        stop: async () => {
          if (stopFails) throw new Error('private stop failure');
          return { status: 'stopped' };
        },
      });
      await assert.rejects(
        run.run(),
        errorWith(503, 'runner_cleanup_failed', /cleanup could not be confirmed/),
      );
      assert.equal(run.calls.deletes.length, 1);
      assert.equal(run.calls.stops.length, stopFails ? 2 : 1);
      assert.equal(run.calls.deletes[0].deleteOrphanSnapshots, true);
      assert.equal(run.calls.deletes[0].signal.aborted, false);
      assert.equal(run.calls.stops[0].signal.aborted, false);
      assert.notEqual(run.calls.deletes[0].signal, run.calls.stops[0].signal);
      assert.deepEqual(
        run.calls.cleanup,
        stopFails ? ['stop', 'stop', 'delete'] : ['stop', 'delete'],
      );
      assert.deepEqual(await fixture().run(), result());
    }
  });

  it('caps active runs at two and releases only the canceled request’s slot', async () => {
    const controller = new AbortController();
    const canceled = fixture({
      logs: async function* ({ signal }) {
        await waitForAbort(signal);
      },
    });
    const gate = deferred();
    const continuing = fixture({
      logs: async function* () {
        await gate.promise;
        yield { stream: 'stdout', data: JSON.stringify(result()) };
      },
    });
    const canceledRun = canceled.run(request(), problem, { signal: controller.signal });
    const rejected = assert.rejects(canceledRun, errorWith(503, 'runner_stopped'));
    const continuingRun = continuing.run();
    await Promise.all([canceled.streaming, continuing.streaming]);
    const blocked = fixture();
    await assert.rejects(blocked.run(), errorWith(429, 'runner_busy'));
    assert.equal(blocked.calls.creates.length, 0);
    controller.abort();
    await rejected;
    assert.equal(canceled.calls.deletes.length, 1);
    assert.equal(continuing.calls.deletes.length, 0);
    assert.equal(continuing.calls.stops.length, 0);
    assert.deepEqual(await fixture().run(), result());
    gate.resolve();
    assert.deepEqual(await continuingRun, result());
    assert.equal(continuing.calls.deletes.length, 1);
    assert.deepEqual(await blocked.run(), result());
  });

  it('keeps a running slot reserved through a stop retry and deletion', async () => {
    let stopAttempts = 0;
    const stopGate = deferred();
    const stopping = deferred();
    const gate = deferred();
    const deleting = deferred();
    const first = fixture({
      stop: async () => {
        if (++stopAttempts === 1) throw new Error('First stop response was lost.');
        stopping.resolve();
        await stopGate.promise;
        return { status: 'stopped' };
      },
      delete: async () => {
        deleting.resolve();
        await gate.promise;
      },
    });
    const firstRun = first.run();
    await stopping.promise;
    assert.deepEqual(first.calls.cleanup, ['stop', 'stop']);
    const secondGate = deferred();
    const second = fixture({
      logs: async function* () {
        await secondGate.promise;
        yield { stream: 'stdout', data: JSON.stringify(result()) };
      },
    });
    const secondRun = second.run();
    await second.streaming;
    const blocked = fixture();
    await assert.rejects(blocked.run(), errorWith(429, 'runner_busy'));
    assert.equal(blocked.calls.creates.length, 0);
    stopGate.resolve();
    await deleting.promise;
    assert.deepEqual(first.calls.cleanup, ['stop', 'stop', 'delete']);
    await assert.rejects(blocked.run(), errorWith(429, 'runner_busy'));
    assert.equal(blocked.calls.creates.length, 0);
    gate.resolve();
    assert.deepEqual(await firstRun, result());
    assert.deepEqual(await blocked.run(), result());
    secondGate.resolve();
    assert.deepEqual(await secondRun, result());
  });
});
