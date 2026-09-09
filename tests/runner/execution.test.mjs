import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { containerArguments, docker, executeProblem } from '../../runner/execution.mjs';

// All subprocesses are replaced before each test. Even submitted strings that
// look like commands are only recorded as JSON; no Docker or learner code runs.
const ID = 'execution-fixture';
const VERSION = 'a'.repeat(64);
const JOB_NAME = 'cp-job-00000000-0000-4000-8000-000000000000';
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
const request = (overrides) => ({
  problemId: ID,
  problemVersion: VERSION,
  code: 'def answer(value):\n    pass\n',
  mode: 'example',
  ...overrides,
});
const result = (count = 1) => ({
  cases: Array.from({ length: count }, (_, i) => ({
    name: `case ${i}`,
    input: 'example',
    expected: 'valid result',
    actual: 'valid result',
    passed: true,
  })),
  stdout: '',
  durationMs: 1.25,
});
const errorWith =
  (status, code = 'invalid_request') =>
  (error) => {
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    return true;
  };
let calls;

function fakeSpawn(command, args, options) {
  const child = new EventEmitter();
  const input = [];
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      input.push(Buffer.from(chunk));
      callback();
    },
  });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  child.unref = () => {};
  calls.push({ command, args, options, child, input });
  return child;
}

function complete(call, value = result(), status = 0) {
  call.child.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
  call.child.emit('close', status);
}

describe('isolated execution boundary', { concurrency: false }, () => {
  beforeEach(() => {
    calls = [];
    mock.method(childProcess, 'spawn', fakeSpawn);
    syncBuiltinESMExports();
  });
  afterEach(() => {
    mock.restoreAll();
    syncBuiltinESMExports();
  });

  it('uses only fixed images with no network, host mounts, privileges, or root user', () => {
    const allowed = {
      python: 'cp-practice-python:2',
      sql: 'cp-practice-python:2',
      shell: 'cp-practice-python:2',
      javascript: 'coding-practice-js:2',
    };
    for (const [runtime, image] of Object.entries(allowed)) {
      const args = containerArguments(runtime, JOB_NAME);
      const option = (flag) => args[args.indexOf(flag) + 1];
      assert.equal(args[0], 'run');
      assert.equal(args.at(-1), image);
      for (const flag of ['--rm', '-i', '--pull=never', '--read-only'])
        assert.ok(args.includes(flag));
      assert.equal(option('--name'), JOB_NAME);
      assert.equal(option('--label'), 'code-practice.runner=1');
      assert.equal(option('--network'), 'none');
      assert.equal(option('--user'), '65534:65534');
      assert.equal(option('--cap-drop'), 'ALL');
      assert.equal(option('--security-opt'), 'no-new-privileges');
      assert.equal(option('--memory'), '1g');
      assert.equal(option('--memory-swap'), '1g');
      assert.equal(option('--cpus'), '2');
      assert.ok(Number(option('--pids-limit')) > 0 && Number(option('--pids-limit')) <= 256);
      assert.deepEqual(
        args.filter((_, i) => args[i - 1] === '--tmpfs'),
        [
          '/work:rw,nosuid,size=256m,mode=1777',
          '/tmp:rw,nosuid,size=128m,mode=1777',
          '/srv:rw,noexec,nosuid,size=4m,mode=1777',
        ],
      );
      assert.ok(
        !args.some((value) =>
          /^(?:--(?:volume|mount|privileged|cap-add|pid|ipc|device)|-v)(?:=|$)/.test(value),
        ),
      );
    }
    assert.equal(calls.length, 0);
  });

  it('rejects inherited keys, arbitrary images, and non-owned container names', () => {
    for (const runtime of [
      'constructor',
      '__proto__',
      'toString',
      'ubuntu:latest',
      'python --privileged',
      null,
      undefined,
    ]) {
      assert.throws(() => containerArguments(runtime, JOB_NAME), /Invalid execution configuration/);
    }
    for (const name of ['', 'user-container', `${JOB_NAME} --privileged`, '../cp-job-anything']) {
      assert.throws(() => containerArguments('python', name), /Invalid execution configuration/);
    }
    assert.equal(calls.length, 0);
  });

  it('rejects malformed requests, unknown IDs, and mismatched catalog identities before spawning', async () => {
    for (const body of [null, undefined, [], 'command', 1])
      await assert.rejects(executeProblem(body, problem), errorWith(400));
    for (const id of ['unknown-problem', 'constructor', '__proto__', 'toString']) {
      await assert.rejects(executeProblem(request({ problemId: id }), null), errorWith(404));
    }
    await assert.rejects(executeProblem(request(), undefined), errorWith(404));
    await assert.rejects(
      executeProblem(request(), { ...problem, id: 'different-problem' }),
      errorWith(404),
    );
    assert.equal(calls.length, 0);
  });

  it('imports and executes with filesystem grading reads disabled', async () => {
    for (const method of ['readFileSync', 'readdirSync']) {
      mock.method(fs, method, () => {
        throw new Error('Execution must not read a local grading catalog.');
      });
    }
    syncBuiltinESMExports();
    const isolated = await import('../../runner/execution.mjs?without-local-grading-files');
    const pending = isolated.executeProblem(request(), problem);
    complete(calls[0]);
    assert.deepEqual(await pending, result());
  });

  it('fails closed for missing or malformed database specs without trusting client substitutes', async () => {
    const inheritedSpec = Object.create(gradingSpec);
    const inheritedCase = Object.create(gradingSpec.cases[0]);
    const invalidSpecs = [
      null,
      undefined,
      [],
      {},
      inheritedSpec,
      ...['constructor', '__proto__', 'toString', 'unknown', null].map((runtime) => ({
        ...gradingSpec,
        runtime,
      })),
      ...[undefined, null, {}, [], Array(33).fill(gradingSpec.cases[0]), [inheritedCase], [{}]].map(
        (cases) => ({ ...gradingSpec, cases }),
      ),
      { ...gradingSpec, privateNote: '界'.repeat(350_000) },
    ];
    for (const value of invalidSpecs) {
      await assert.rejects(
        executeProblem(request({ spec: gradingSpec, gradingSpec }), {
          ...problem,
          gradingSpec: value,
        }),
        errorWith(503, 'grading_unavailable'),
      );
    }
    await assert.rejects(
      executeProblem(
        request({ spec: gradingSpec }),
        Object.assign(Object.create({ gradingSpec }), { id: ID, version: VERSION }),
      ),
      errorWith(503, 'grading_unavailable'),
    );
    assert.equal(calls.length, 0);
  });

  it('bounds the complete serialized protocol payload to exactly one MiB before spawning', async () => {
    const spec = { ...gradingSpec, padding: '' };
    const body = request();
    const emptyPayload = {
      protocolVersion: 2,
      problemId: ID,
      problemVersion: VERSION,
      spec,
      code: body.code,
      mode: body.mode,
    };
    spec.padding = 'x'.repeat(1024 * 1024 - Buffer.byteLength(JSON.stringify(emptyPayload)));
    const pending = executeProblem(body, { ...problem, gradingSpec: spec });
    assert.equal(Buffer.concat(calls[0].input).length, 1024 * 1024);
    complete(calls[0]);
    assert.deepEqual(await pending, result());
    await assert.rejects(
      executeProblem(body, { ...problem, gradingSpec: { ...spec, padding: spec.padding + 'x' } }),
      errorWith(503, 'grading_unavailable'),
    );
    assert.equal(calls.length, 1);
  });

  it('rejects stale or missing problem versions and invalid bounded inputs before spawning', async () => {
    for (const problemVersion of [undefined, null, 'b'.repeat(64)]) {
      await assert.rejects(
        executeProblem(request({ problemVersion }), problem),
        errorWith(409, 'problem_changed'),
      );
    }
    for (const code of [undefined, null, [], 'a'.repeat(32_769), '界'.repeat(17_067)]) {
      await assert.rejects(executeProblem(request({ code }), problem), errorWith(400));
    }
    for (const mode of [undefined, 'arbitrary-command', 'all', 1]) {
      await assert.rejects(executeProblem(request({ mode }), problem), errorWith(400));
    }
    for (const customArgs of [undefined, null, {}, 'x'.repeat(8_193)]) {
      await assert.rejects(
        executeProblem(request({ mode: 'custom', customArgs }), problem),
        errorWith(400),
      );
    }
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      executeProblem(request(), problem, { signal: controller.signal }),
      errorWith(400),
    );
    assert.equal(calls.length, 0);
  });

  it('forwards the database-owned spec and ignores all counterfeit client grading fields', async () => {
    const code = 'print("literal ; & $(whoami) 🐍")\n';
    const body = request({
      code,
      mode: 'custom',
      customArgs: '([1, 3], 3)',
      runtime: 'javascript',
      image: 'evil-image',
      mounts: ['C:/:/host'],
      network: 'host',
      privileged: true,
      containerName: 'user-container',
      cases: [{ code: 'malicious grading fixture' }],
      spec: { runtime: 'javascript', cases: [] },
      gradingSpec: { runtime: 'shell', cases: [] },
      protocolVersion: 1,
      entryPoint: 'counterfeit',
      expected: 'accepted',
      timeoutMs: 0,
    });
    const pending = executeProblem(body, { ...problem, runtime: 'javascript' });
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.command, docker);
    assert.equal(call.args.at(-1), 'cp-practice-python:2');
    assert.match(call.args[call.args.indexOf('--name') + 1], /^cp-job-[a-f0-9-]{36}$/);
    assert.deepEqual(call.options, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    assert.deepEqual(JSON.parse(Buffer.concat(call.input).toString('utf8')), {
      protocolVersion: 2,
      problemId: ID,
      problemVersion: VERSION,
      spec: gradingSpec,
      code,
      mode: 'custom',
      customArgs: '([1, 3], 3)',
    });
    complete(call);
    assert.deepEqual(await pending, result());
  });

  it('uses the private suite length for submissions and ignores custom input outside custom mode', async () => {
    const pending = executeProblem(
      request({ mode: 'submit', customArgs: 'not forwarded', cases: [] }),
      problem,
    );
    const call = calls[0];
    assert.ok(!Object.hasOwn(JSON.parse(Buffer.concat(call.input).toString('utf8')), 'customArgs'));
    complete(call, result(3));
    assert.equal((await pending).cases.length, 3);
  });

  it('rejects malformed results and inconsistent case counts without reporting a solved result', async () => {
    for (const value of [
      'not-json',
      null,
      {},
      { ...result(), durationMs: '1' },
      result(0),
      result(2),
      result(33),
    ]) {
      const pending = executeProblem(request(), problem);
      complete(calls.at(-1), value);
      await assert.rejects(pending, errorWith(503, 'invalid_runner_result'));
    }
    const pending = executeProblem(request({ mode: 'submit' }), problem);
    complete(calls.at(-1), result(1));
    await assert.rejects(pending, errorWith(503, 'invalid_runner_result'));
  });

  it('returns genuine runner errors and never reinterprets them as accepted cases', async () => {
    const pending = executeProblem(request(), problem);
    const value = { cases: [], durationMs: 0, stdout: '', error: 'SyntaxError: invalid syntax' };
    complete(calls[0], value);
    assert.deepEqual(await pending, value);
  });

  it('reports missing Docker or a failed container explicitly and releases its running slot', async () => {
    const unavailable = executeProblem(request(), problem);
    calls[0].child.emit('error', new Error('spawn ENOENT'));
    await assert.rejects(unavailable, errorWith(503, 'runner_unavailable'));
    const failed = executeProblem(request(), problem);
    complete(calls.at(-1), 'private diagnostic not shown to learner', 125);
    await assert.rejects(failed, errorWith(503, 'runner_unavailable'));
    const healthy = executeProblem(request(), problem);
    complete(calls.at(-1));
    assert.deepEqual(await healthy, result());
  });

  it('cancels only the exact generated container and ignores its late result', async () => {
    const controller = new AbortController();
    const pending = executeProblem(request(), problem, { signal: controller.signal });
    const run = calls[0];
    controller.abort();
    await assert.rejects(pending, errorWith(503, 'runner_stopped'));
    assert.equal(run.child.killed, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].command, docker);
    assert.deepEqual(calls[1].args, ['rm', '-f', run.args[run.args.indexOf('--name') + 1]]);
    assert.deepEqual(calls[1].options, { windowsHide: true, stdio: 'ignore' });
    complete(run);
    assert.equal(calls.length, 2);
  });

  it('stops oversized output and cleans up only its own container', async () => {
    const pending = executeProblem(request(), problem);
    const run = calls[0];
    run.child.stdout.write(Buffer.alloc(512_001, 32));
    await assert.rejects(pending, errorWith(503, 'runner_stopped'));
    assert.equal(run.child.killed, true);
    assert.deepEqual(calls[1].args, ['rm', '-f', run.args[run.args.indexOf('--name') + 1]]);
  });

  it('enforces the trusted deadline even when the submitted request asks for unlimited time', async () => {
    const pending = executeProblem(request({ timeoutMs: 0 }), problem, { timeoutMs: 5 });
    await assert.rejects(pending, errorWith(503, 'runner_stopped'));
    assert.equal(calls[0].child.killed, true);
    assert.deepEqual(calls[1].args, [
      'rm',
      '-f',
      calls[0].args[calls[0].args.indexOf('--name') + 1],
    ]);
  });

  it('caps active runs at two and releases capacity after they finish', async () => {
    const first = executeProblem(request(), problem);
    const second = executeProblem(request(), problem);
    await assert.rejects(executeProblem(request(), problem), errorWith(429, 'runner_busy'));
    assert.equal(calls.length, 2);
    assert.notEqual(calls[0].args[5], calls[1].args[5]);
    complete(calls[0]);
    complete(calls[1]);
    await Promise.all([first, second]);
    const next = executeProblem(request(), problem);
    complete(calls.at(-1));
    assert.deepEqual(await next, result());
  });

  it('accepts inputs at the exact character, byte, and custom-input limits', async () => {
    const boundedRequests = [
      request({ code: 'a'.repeat(32_768) }),
      request({ code: '界'.repeat(17_066) + 'aa' }),
      request({ mode: 'custom', customArgs: 'x'.repeat(8_192) }),
    ];
    for (const body of boundedRequests) {
      const pending = executeProblem(body, problem);
      complete(calls.at(-1));
      assert.deepEqual(await pending, result());
    }
    assert.equal(calls.length, boundedRequests.length);
  });

  it('accepts exactly the stdout limit and keeps stderr separate from the returned result', async () => {
    const pending = executeProblem(request(), problem);
    const run = calls[0];
    run.child.stderr.write(Buffer.alloc(16_384, 120));
    run.child.stderr.write('private diagnostics');
    complete(run, JSON.stringify(result()).padEnd(512_000, ' '));
    assert.deepEqual(await pending, result());
    assert.equal(run.child.killed, false);
    assert.equal(calls.length, 1);
  });

  it('does not stop completed or failed runs when canceled later', async () => {
    for (const status of [0, 125]) {
      const controller = new AbortController();
      const pending = executeProblem(request(), problem, { signal: controller.signal });
      const run = calls.at(-1);
      complete(run, result(), status);
      if (status === 0) assert.deepEqual(await pending, result());
      else await assert.rejects(pending, errorWith(503, 'runner_unavailable'));
      controller.abort();
      assert.equal(run.child.killed, false);
    }
    assert.equal(calls.length, 2);
  });

  it('releases a canceled run slot without stopping the other active request', async () => {
    const controller = new AbortController();
    const canceled = executeProblem(request(), problem, { signal: controller.signal });
    const canceledRun = calls[0];
    const continuing = executeProblem(request(), problem);
    const continuingRun = calls[1];
    controller.abort();
    await assert.rejects(canceled, errorWith(503, 'runner_stopped'));
    assert.equal(continuingRun.child.killed, false);

    const replacement = executeProblem(request(), problem);
    const replacementRun = calls.at(-1);
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[2].args, [
      'rm',
      '-f',
      canceledRun.args[canceledRun.args.indexOf('--name') + 1],
    ]);
    complete(canceledRun);
    canceledRun.child.emit('error', new Error('late failure'));
    complete(continuingRun);
    complete(replacementRun);
    assert.deepEqual(await Promise.all([continuing, replacement]), [result(), result()]);
    assert.equal(calls.length, 4);
  });
});
