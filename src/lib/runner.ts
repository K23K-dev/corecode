export type TestCase = {
  name: string;
  args: string;
  expected: string;
  check?: 'unchanged' | 'independent_rows';
};

export type CaseResult = {
  name: string;
  input: string;
  expected?: string;
  actual?: string;
  passed?: boolean;
  error?: string;
};

export type RunResult = {
  cases: CaseResult[];
  stdout: string;
  durationMs: number;
  error?: string;
};

export type RunnerStage = 'loading' | 'running';
type RunRequest = { code: string; entryPoint: string; cases: TestCase[]; customArgs?: string };
type ActiveRun = {
  id: string;
  resolve: (value: RunResult) => void;
  reject: (reason: Error) => void;
  onStage?: (stage: RunnerStage) => void;
  running: boolean;
  timer: ReturnType<typeof setTimeout>;
};

const APP_ORIGIN = 'http://127.0.0.1:5173';
const RUNNER_ORIGIN = 'http://127.0.0.1:4174';
const shortText = (value: unknown, limit = 2_048): string =>
  typeof value === 'string' ? value.slice(0, limit) : '';

function sanitizeResult(value: unknown): RunResult {
  if (!value || typeof value !== 'object') throw new Error('Python returned an invalid result.');
  const result = value as Record<string, unknown>;
  if (!Array.isArray(result.cases) || result.cases.length > 32)
    throw new Error('Python returned invalid case results.');
  return {
    cases: result.cases.map((value: unknown): CaseResult => {
      if (!value || typeof value !== 'object') throw new Error('Python returned an invalid case.');
      const item = value as Record<string, unknown>;
      const row: CaseResult = {
        name: shortText(item.name, 80),
        input: shortText(item.input, 8_192),
      };
      if (typeof item.expected === 'string') row.expected = shortText(item.expected, 8_192);
      if (typeof item.actual === 'string') row.actual = shortText(item.actual);
      if (typeof item.error === 'string') row.error = shortText(item.error);
      if (typeof item.passed === 'boolean') row.passed = item.passed;
      return row;
    }),
    stdout: shortText(result.stdout, 8_224),
    durationMs:
      typeof result.durationMs === 'number' && Number.isFinite(result.durationMs)
        ? Math.min(4_000, Math.max(0, result.durationMs))
        : 0,
    ...(typeof result.error === 'string' ? { error: shortText(result.error) } : {}),
  };
}

function validateRequest(request: RunRequest): RunRequest {
  if (typeof request.code !== 'string' || request.code.length > 32_768)
    throw new Error('Keep code below 32,768 characters.');
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(request.entryPoint))
    throw new Error('Invalid function name.');
  if (
    !Array.isArray(request.cases) ||
    request.cases.length > 32 ||
    (!request.cases.length && request.customArgs === undefined)
  )
    throw new Error('Provide between 1 and 32 test cases.');
  for (const item of request.cases) {
    if (
      typeof item.name !== 'string' ||
      item.name.length > 80 ||
      typeof item.args !== 'string' ||
      item.args.length > 8_192 ||
      typeof item.expected !== 'string' ||
      item.expected.length > 8_192
    )
      throw new Error('A test case exceeds the input size limits.');
    if (item.check !== undefined && item.check !== 'unchanged' && item.check !== 'independent_rows')
      throw new Error('Unknown behavioral check.');
  }
  if (
    request.customArgs !== undefined &&
    (typeof request.customArgs !== 'string' || request.customArgs.length > 8_192)
  )
    throw new Error('Keep custom input below 8,192 characters.');
  const copy = JSON.parse(JSON.stringify(request)) as RunRequest;
  if (JSON.stringify(copy).length > 196_608) throw new Error('Run input is too large.');
  return copy;
}

export class PythonRunner {
  private frame: HTMLIFrameElement;
  private readonly channel = crypto.randomUUID();
  private ready = false;
  private disposed = false;
  private active: ActiveRun | null = null;
  private pendingRequest: RunRequest | null = null;
  private readonly onMessage = (event: MessageEvent): void => {
    if (event.origin !== RUNNER_ORIGIN || event.source !== this.frame.contentWindow) return;
    const message: unknown = event.data;
    if (!message || typeof message !== 'object') return;
    const data = message as Record<string, unknown>;
    if (data.channel !== this.channel) return;
    if (data.type === 'ready') {
      this.ready = true;
      this.dispatch();
      return;
    }
    const active = this.active;
    if (!active || data.id !== active.id) return;
    if (data.type === 'stage' && data.stage === 'running') {
      if (active.running) return;
      active.running = true;
      clearTimeout(active.timer);
      active.timer = setTimeout(
        () => this.fail('Execution exceeded 4 seconds and was stopped.'),
        4_250,
      );
      active.onStage?.('running');
    } else if (data.type === 'failure') {
      this.fail(shortText(data.error) || 'Python startup failed.');
    } else if (data.type === 'result') {
      try {
        const result = sanitizeResult(data.result);
        clearTimeout(active.timer);
        this.active = null;
        this.pendingRequest = null;
        active.resolve(result);
      } catch (error) {
        this.fail(error instanceof Error ? error.message : 'Invalid Python result.');
      }
    }
  };

  constructor() {
    if (window.location.origin !== APP_ORIGIN)
      throw new Error(`Open the app at ${APP_ORIGIN} to use Python execution.`);
    this.frame = document.createElement('iframe');
    this.frame.title = 'Isolated local Python execution';
    this.frame.hidden = true;
    this.frame.tabIndex = -1;
    this.frame.setAttribute('aria-hidden', 'true');
    this.frame.sandbox.add('allow-scripts', 'allow-same-origin');
    this.frame.referrerPolicy = 'no-referrer';
    this.frame.src = `${RUNNER_ORIGIN}/runner.html#${this.channel}`;
    window.addEventListener('message', this.onMessage);
    document.body.append(this.frame);
  }

  run(request: RunRequest, onStage?: (stage: RunnerStage) => void): Promise<RunResult> {
    if (this.disposed) return Promise.reject(new Error('The Python runner has been disposed.'));
    let payload: RunRequest;
    try {
      payload = validateRequest(request);
    } catch (error) {
      return Promise.reject(error);
    }
    this.cancel();
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      this.active = {
        id,
        resolve,
        reject,
        onStage,
        running: false,
        timer: setTimeout(
          () => this.fail('Python startup timed out. Make sure the local runner is running.'),
          95_000,
        ),
      };
      this.pendingRequest = payload;
      onStage?.('loading');
      this.dispatch();
    });
  }

  private dispatch(): void {
    if (!this.ready || !this.active || !this.pendingRequest) return;
    this.frame.contentWindow?.postMessage(
      { type: 'run', id: this.active.id, channel: this.channel, payload: this.pendingRequest },
      RUNNER_ORIGIN,
    );
    this.pendingRequest = null;
  }

  private fail(message: string): void {
    const active = this.active;
    if (!active) return;
    this.frame.contentWindow?.postMessage(
      { type: 'cancel', id: active.id, channel: this.channel },
      RUNNER_ORIGIN,
    );
    clearTimeout(active.timer);
    this.active = null;
    this.pendingRequest = null;
    active.reject(new Error(message.slice(0, 2_048)));
  }

  cancel(): void {
    this.fail('Run stopped.');
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    window.removeEventListener('message', this.onMessage);
    this.frame.remove();
  }
}
