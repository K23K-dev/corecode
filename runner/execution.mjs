import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { plainObject, RequestError } from '../server/validation.mjs';

const MAX_CODE_CHARACTERS = 32_768;
const MAX_CODE_BYTES = 51_200;
const MAX_CUSTOM_INPUT_CHARACTERS = 8_192;
const MAX_OUTPUT_BYTES = 512_000;
const STDERR_CAPTURE_THRESHOLD = 8_192;
const MAX_RESULT_CASES = 32;
const MAX_RUNNER_PAYLOAD_BYTES = 1024 * 1024;
const MAX_ACTIVE_RUNS = 2;
const DEFAULT_TIMEOUT_MS = 20_000;

const windowsDockerPath = 'C:/Program Files/Docker/Docker/resources/bin/docker.exe';
export const docker =
  process.platform === 'win32' && existsSync(windowsDockerPath) ? windowsDockerPath : 'docker';
const images = {
  python: 'cp-practice-python:2',
  sql: 'cp-practice-python:2',
  shell: 'cp-practice-python:2',
  javascript: 'coding-practice-js:2',
};
let activeRuns = 0;

export function containerArguments(runtime, name) {
  if (!Object.hasOwn(images, runtime) || !/^cp-job-[a-f0-9-]{36}$/.test(name)) {
    throw Error('Invalid execution configuration');
  }

  return [
    'run',
    '--rm',
    '-i',
    '--pull=never',
    '--name',
    name,
    '--label',
    'code-practice.runner=1',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    '256',
    '--memory',
    '1g',
    '--memory-swap',
    '1g',
    '--cpus',
    '2',
    '--user',
    '65534:65534',
    '--tmpfs',
    '/work:rw,nosuid,size=256m,mode=1777',
    '--tmpfs',
    '/tmp:rw,nosuid,size=128m,mode=1777',
    '--tmpfs',
    '/srv:rw,noexec,nosuid,size=4m,mode=1777',
    '--env',
    'HOME=/work',
    '--env',
    'TMPDIR=/tmp',
    images[runtime],
  ];
}

function validateExecutionRequest(body, problem) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError('Invalid run request.');
  }

  if (!problem || !Object.hasOwn(problem, 'id') || problem.id !== body.problemId) {
    throw new RequestError('Unknown problem.', 404);
  }
  if (body.problemVersion !== problem.version) {
    throw new RequestError(
      'This problem changed. Refresh before submitting.',
      409,
      'problem_changed',
    );
  }
  if (
    typeof body.code !== 'string' ||
    body.code.length > MAX_CODE_CHARACTERS ||
    Buffer.byteLength(body.code) > MAX_CODE_BYTES
  ) {
    throw new RequestError('Keep code under 32,768 characters and 50 KiB.');
  }
  if (!['example', 'submit', 'custom'].includes(body.mode)) {
    throw new RequestError('Invalid run mode.');
  }
  if (
    body.mode === 'custom' &&
    (typeof body.customArgs !== 'string' || body.customArgs.length > MAX_CUSTOM_INPUT_CHARACTERS)
  ) {
    throw new RequestError('Invalid custom input.');
  }
}

function gradingUnavailable() {
  return new RequestError(
    'Grading is temporarily unavailable for this problem. Nothing was marked solved.',
    503,
    'grading_unavailable',
  );
}

function readGradingSpec(problem) {
  try {
    if (
      !Object.hasOwn(problem, 'version') ||
      typeof problem.version !== 'string' ||
      !/^[a-f0-9]{64}$/.test(problem.version) ||
      !Object.hasOwn(problem, 'gradingSpec')
    ) {
      throw gradingUnavailable();
    }
    const spec = plainObject(problem.gradingSpec, 'Grading specification');
    if (
      !Object.hasOwn(spec, 'runtime') ||
      typeof spec.runtime !== 'string' ||
      !Object.hasOwn(images, spec.runtime) ||
      !Object.hasOwn(spec, 'cases') ||
      !Array.isArray(spec.cases) ||
      spec.cases.length < 1 ||
      spec.cases.length > MAX_RESULT_CASES
    ) {
      throw gradingUnavailable();
    }
    for (const value of spec.cases) {
      const testCase = plainObject(value, 'Grading case');
      if (
        !Object.hasOwn(testCase, 'name') ||
        typeof testCase.name !== 'string' ||
        !Object.hasOwn(testCase, 'expected') ||
        typeof testCase.expected !== 'string'
      ) {
        throw gradingUnavailable();
      }
    }
    const serialized = JSON.stringify(spec);
    if (Buffer.byteLength(serialized) > MAX_RUNNER_PAYLOAD_BYTES) throw gradingUnavailable();
    return JSON.parse(serialized);
  } catch {
    throw gradingUnavailable();
  }
}

function createRunnerPayload(body, problem, spec) {
  const payload = {
    protocolVersion: 2,
    problemId: problem.id,
    problemVersion: problem.version,
    spec,
    code: body.code,
    mode: body.mode,
  };
  if (body.mode === 'custom') payload.customArgs = body.customArgs;
  const serialized = JSON.stringify(payload);
  if (Buffer.byteLength(serialized) > MAX_RUNNER_PAYLOAD_BYTES) throw gradingUnavailable();
  return serialized;
}

export function parseRunnerResult(chunks, spec, body) {
  try {
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (
      !result ||
      !Array.isArray(result.cases) ||
      result.cases.length > MAX_RESULT_CASES ||
      typeof result.durationMs !== 'number'
    ) {
      throw Error('Invalid result shape');
    }

    const expectedCaseCount = body.mode === 'submit' ? spec.cases.length : 1;
    if (!result.error && result.cases.length !== expectedCaseCount) {
      throw Error('Unexpected case count');
    }
    return result;
  } catch {
    throw new RequestError(
      'The runner returned an invalid result. Nothing was marked solved.',
      503,
      'invalid_runner_result',
    );
  }
}

/** Both execution adapters use the same private spec and protocol validation. */
export function prepareExecution(body, problem) {
  validateExecutionRequest(body, problem);
  const spec = readGradingSpec(problem);
  return { spec, payload: createRunnerPayload(body, problem, spec) };
}

function runContainer({ body, spec, payload, name, signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(docker, containerArguments(spec.runtime, name), {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    let stdoutBytes = 0;
    let ended = false;
    let timer;

    function finishOnce() {
      if (ended) return false;
      ended = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      return true;
    }

    function stop(message) {
      if (!finishOnce()) return;

      // Only the exact UUID-named container owned by this request is removed.
      const removal = spawn(docker, ['rm', '-f', name], {
        windowsHide: true,
        stdio: 'ignore',
      });
      removal.on('error', () => {});
      removal.unref();
      child.kill();
      reject(new RequestError(message, 503, 'runner_stopped'));
    }

    function abort() {
      stop('Run canceled. Your code is still saved.');
    }

    function handleSpawnError() {
      if (!finishOnce()) return;
      reject(
        new RequestError(
          'Docker is unavailable. Start Docker Desktop, then try again.',
          503,
          'runner_unavailable',
        ),
      );
    }

    function collectStdout(chunk) {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        stop('Execution produced too much output.');
      } else {
        stdoutChunks.push(chunk);
      }
    }

    function collectStderr(chunk) {
      const capturedBytes = stderrChunks.reduce((total, captured) => total + captured.length, 0);
      if (capturedBytes < STDERR_CAPTURE_THRESHOLD) stderrChunks.push(chunk);
    }

    function handleClose(status) {
      if (!finishOnce()) return;
      if (status !== 0) {
        reject(
          new RequestError(
            'The isolated runner could not finish. Start Docker Desktop; if this is the first setup, run npm run runner:setup.',
            503,
            'runner_unavailable',
          ),
        );
        return;
      }

      try {
        resolve(parseRunnerResult(stdoutChunks, spec, body));
      } catch (error) {
        reject(error);
      }
    }

    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => stop('Execution exceeded 20 seconds and was stopped.'), timeoutMs);
    child.stdin.on('error', () => {});
    child.on('error', handleSpawnError);
    child.stdout.on('data', collectStdout);
    child.stderr.on('data', collectStderr);
    child.on('close', handleClose);
    child.stdin.end(payload);
  });
}

export async function executeProblem(
  body,
  problem,
  { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const { spec, payload } = prepareExecution(body, problem);
  if (activeRuns >= MAX_ACTIVE_RUNS) {
    throw new RequestError(
      'Two runs are already active. Wait for one to finish.',
      429,
      'runner_busy',
    );
  }
  if (signal?.aborted) throw new RequestError('Run canceled.');

  const name = 'cp-job-' + randomUUID();
  activeRuns++;
  try {
    return await runContainer({ body, spec, payload, name, signal, timeoutMs });
  } finally {
    activeRuns--;
  }
}
