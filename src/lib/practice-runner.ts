import type { Exercise } from './exercises';
import { PythonRunner, type RunResult, type RunnerStage } from './runner';

/** Local Python uses the separate browser origin; hosted runs use the private API. */
export class PracticeRunner {
  private python: PythonRunner | null = null;
  private request: AbortController | null = null;
  async run(
    exercise: Exercise,
    code: string,
    mode: 'example' | 'submit' | 'custom',
    customArgs: string,
    onStage: (stage: RunnerStage) => void,
  ): Promise<RunResult> {
    const localApp = globalThis.location?.origin === 'http://127.0.0.1:5173';
    if (localApp && (exercise.runtime === 'browser-python' || !exercise.runtime)) {
      this.python ??= new PythonRunner();
      return this.python.run(
        {
          code,
          entryPoint: exercise.entryPoint!,
          cases: mode === 'submit' ? exercise.cases! : exercise.cases!.slice(0, 1),
          ...(mode === 'custom' ? { customArgs } : {}),
        },
        onStage,
      );
    }
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
    this.python?.cancel();
  }
  dispose() {
    this.cancel();
    this.python?.dispose();
  }
}
