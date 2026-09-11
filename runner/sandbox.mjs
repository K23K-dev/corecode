import { randomUUID } from 'node:crypto';
import { Sandbox } from '@vercel/sandbox';
import { RequestError } from '../server/validation.mjs';
import { containerArguments, parseRunnerResult, prepareExecution } from './execution.mjs';

const MAX_OUTPUT_BYTES = 512_000;
const MAX_ACTIVE_RUNS = 2;
const JOB_TIMEOUT_MS = 90_000;
const CODE_TIMEOUT_MS = 20_000;
let activeRuns = 0;

const unavailable = () =>
  new RequestError(
    'The hosted code runner is unavailable. Your code is still saved; nothing was marked solved.',
    503,
    'runner_unavailable',
  );

/** Trusted setup only. Submitted code never runs in this outer, privileged VM. */
export async function startSandboxDocker(sandbox, signal) {
  const result = await sandbox.runCommand({
    cmd: 'sh',
    // Snapshot restores can default to the legacy /vercel/sandbox directory.
    cwd: '/vercel',
    args: [
      '-c',
      // The SDK's file-transfer API also uses the legacy restore directory.
      'mkdir -p /vercel/sandbox || exit 1; ' +
        // Prepare cgroup-v2 nesting before Docker enables resource controllers.
        // This bounded adaptation of Moby's hack/dind moves only guest processes;
        // learner containers retain all memory, CPU, and process limits.
        'test -f /sys/fs/cgroup/cgroup.controllers || exit 1; ' +
        'mkdir -p /sys/fs/cgroup/code-practice-init || exit 1; ' +
        'cgroups_ready=0; for attempt in $(seq 1 20); do ' +
        '(xargs -rn1 < /sys/fs/cgroup/cgroup.procs ' +
        '> /sys/fs/cgroup/code-practice-init/cgroup.procs) 2>/dev/null || true; ' +
        'if printf "+cpu +memory +pids\\n" > /sys/fs/cgroup/cgroup.subtree_control; ' +
        'then cgroups_ready=1; break; fi; sleep 0.1; done; ' +
        'test "$cgroups_ready" -eq 1 || exit 1; ' +
        'nohup dockerd --host=unix:///var/run/docker.sock --pidfile=/var/run/docker.pid ' +
        '--iptables=false --bridge=none --ip-forward=false --ip-masq=false ' +
        '> /tmp/code-practice-docker.log 2>&1 < /dev/null & ' +
        'for attempt in $(seq 1 250); do ' +
        'docker info > /dev/null 2>&1 && exit 0; sleep 0.1; done; exit 1',
    ],
    sudo: true,
    timeoutMs: 30_000,
    signal,
  });
  if (result.exitCode !== 0) {
    throw new RequestError(
      'The hosted runner could not start. Your code is still saved; please try again.',
      503,
      'runner_startup_failed',
    );
  }
}

async function disposeSandbox(sandbox) {
  let stopped = false;
  let deleted = false;
  // Deleting metadata can return before the VM releases its concurrency slot.
  // Stop is idempotent: retry only cleanup, never the learner's execution.
  for (let attempt = 0; attempt < 2 && !stopped; attempt++) {
    try {
      const result = await sandbox.stop({ signal: AbortSignal.timeout(15_000) });
      stopped = result?.status === 'stopped' || result?.status === 'failed';
    } catch {
      // A lost stop response may still mean shutdown succeeded. Confirm it once
      // more with a fresh signal, then always attempt exact-resource deletion.
    }
  }
  try {
    // Never reuse either the request's signal or the stop operation's signal.
    await sandbox.delete({ deleteOrphanSnapshots: true, signal: AbortSignal.timeout(5_000) });
    deleted = true;
  } catch {
    // The VM also has an independent 90-second deadline if the control plane fails.
  }
  if (!stopped || !deleted) {
    throw new RequestError(
      'Runner cleanup could not be confirmed. Wait 90 seconds before trying again.',
      503,
      'runner_cleanup_failed',
    );
  }
}

async function runJob(sandbox, body, spec, payload, name, signal) {
  await startSandboxDocker(sandbox, signal);
  signal.throwIfAborted();
  await sandbox.writeFiles(
    [{ path: '/tmp/code-practice-request.json', content: Buffer.from(payload) }],
    { signal },
  );
  // Only fixed shell text is interpreted. Learner code/specs enter the inner
  // container through stdin, never arguments, host mounts, or environment vars.
  const command = await sandbox.runCommand({
    cmd: 'sh',
    cwd: '/vercel',
    args: [
      '-c',
      'exec docker "$@" < /tmp/code-practice-request.json',
      'code-practice',
      ...containerArguments(spec.runtime, name),
    ],
    sudo: true,
    detached: true,
    timeoutMs: CODE_TIMEOUT_MS,
    signal,
  });
  const chunks = [];
  let bytes = 0;
  // Do not call stdout()/output(): those aggregate unbounded learner output.
  for await (const entry of command.logs({ signal })) {
    const chunk = Buffer.from(entry.data);
    bytes += chunk.length;
    if (bytes > MAX_OUTPUT_BYTES) {
      throw new RequestError('Execution produced too much output.', 503, 'runner_stopped');
    }
    if (entry.stream === 'stdout') chunks.push(chunk);
  }
  const result = await command.wait({ signal });
  if (result.exitCode !== 0) throw unavailable();
  return parseRunnerResult(chunks, spec, body);
}

/** Same grading protocol as local Docker; only the execution location differs. */
export async function executeSandboxProblem(
  body,
  problem,
  {
    signal,
    snapshotId = process.env.RUNNER_SANDBOX_SNAPSHOT,
    sandboxClient = Sandbox,
    timeoutMs = JOB_TIMEOUT_MS,
  } = {},
) {
  const { spec, payload } = prepareExecution(body, problem);
  if (typeof snapshotId !== 'string' || !/^snap_[A-Za-z0-9_-]{1,180}$/.test(snapshotId)) {
    throw new RequestError(
      'The hosted runner has not been set up yet. Your code is still saved.',
      503,
      'runner_not_configured',
    );
  }
  if (activeRuns >= MAX_ACTIVE_RUNS) {
    throw new RequestError(
      'Two runs are already active. Wait for one to finish.',
      429,
      'runner_busy',
    );
  }
  if (signal?.aborted) throw new RequestError('Run canceled.', 503, 'runner_stopped');

  const name = 'cp-job-' + randomUUID();
  const deadline = AbortSignal.timeout(timeoutMs);
  const operation = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let sandbox;
  activeRuns++;
  try {
    // Let creation finish even when the browser cancels, so we retain the exact
    // returned handle for cleanup. Never fork/resume another learner's session.
    sandbox = await sandboxClient.create({
      name,
      source: { type: 'snapshot', snapshotId },
      persistent: false,
      networkPolicy: 'deny-all',
      ports: [],
      resources: { vcpus: 2 },
      timeout: JOB_TIMEOUT_MS,
      signal: deadline,
    });
    operation.throwIfAborted();
    return await runJob(sandbox, body, spec, payload, name, operation);
  } catch (error) {
    if (signal?.aborted) {
      throw new RequestError('Run canceled. Your code is still saved.', 503, 'runner_stopped');
    }
    if (deadline.aborted) {
      throw new RequestError('The hosted run timed out and was stopped.', 503, 'runner_stopped');
    }
    if (error instanceof RequestError) throw error;
    if (
      !sandbox &&
      error?.response?.status === 429 &&
      error?.json?.error?.code === 'rate_limit_exceeded'
    ) {
      throw new RequestError(
        'The hosted runner is busy. Wait a moment before trying again.',
        429,
        'runner_busy',
      );
    }
    // SDK errors can contain private request/credential information.
    throw unavailable();
  } finally {
    try {
      if (!sandbox) {
        // A failed create response can still leave a resource behind. Only look
        // up the unpredictable name allocated by this request, without resuming.
        sandbox = await sandboxClient
          .get({ name, resume: false, signal: AbortSignal.timeout(5_000) })
          .catch(() => null);
      }
      if (sandbox) await disposeSandbox(sandbox);
    } finally {
      activeRuns--;
    }
  }
}
