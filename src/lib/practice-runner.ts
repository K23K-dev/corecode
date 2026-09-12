import type { Exercise } from './exercises';

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

/** Every exercise uses the private API and its configured isolated execution adapter. */
export class PracticeRunner {
  private request: AbortController | null = null;
  async run(
    exercise: Exercise,
    code: string,
    mode: 'example' | 'submit' | 'custom',
    customArgs: string,
    onStage: (stage: RunnerStage) => void,
  ): Promise<RunResult> {
    const localApp = globalThis.location?.origin === 'http://127.0.0.1:5173';
    const controller = new AbortController();
    this.request = controller;
    onStage('running');
    // Hosted requests include the database lookup, fresh VM startup, and bounded cleanup.
    const timer = setTimeout(() => controller.abort(), localApp ? 25_000 : 165_000);
    try {
      const response = await fetch('/api/run', {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json', 'X-Code-Practice-Client': '1' },
        body: JSON.stringify({
          problemId: exercise.id,
          problemVersion: exercise.version,
          code,
          mode,
          ...(mode === 'custom' ? { customArgs } : {}),
        }),
      });
      const text = await response.text();
      if (text.length > 512000) throw new Error('The runner response was too large.');
      if (response.status === 401 || response.status === 403)
        throw new Error('Open the website and sign in again before running code.');
      if (!response.headers.get('content-type')?.includes('application/json'))
        throw new Error('The code execution API is unavailable. Your code is still saved.');
      const result = JSON.parse(text);
      if (!response.ok) throw new Error(result.error ?? 'The isolated runner is unavailable.');
      if (!Array.isArray(result.cases) || result.cases.length > 32)
        throw new Error('Invalid runner response.');
      return result as RunResult;
    } finally {
      clearTimeout(timer);
      if (this.request === controller) this.request = null;
    }
  }
  cancel() {
    this.request?.abort();
  }
  dispose() {
    this.cancel();
  }
}
