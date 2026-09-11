import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Exercise } from '../src/lib/exercises';

const browser = vi.hoisted(() => ({
  run: vi.fn(),
  cancel: vi.fn(),
  dispose: vi.fn(),
  created: vi.fn(),
}));
vi.mock('../src/lib/runner', () => ({
  PythonRunner: class {
    constructor() {
      browser.created();
    }
    run = browser.run;
    cancel = browser.cancel;
    dispose = browser.dispose;
  },
}));
import { PracticeRunner } from '../src/lib/practice-runner';

const exercise = {
  id: 'python-fixture',
  version: 'a'.repeat(64),
  runtime: 'browser-python',
  entryPoint: 'answer',
  cases: [{ name: 'Example', args: '(1,)', expected: '2' }],
} as Exercise;
const result = { cases: [], stdout: '', durationMs: 1 };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('local and hosted execution routing', () => {
  it('keeps the existing isolated browser runner for the local app', async () => {
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:5173' });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    browser.run.mockResolvedValueOnce(result);
    const runner = new PracticeRunner();
    expect(await runner.run(exercise, 'pass', 'submit', '', vi.fn())).toEqual(result);
    expect(browser.created).toHaveBeenCalledOnce();
    expect(browser.run).toHaveBeenCalledWith(
      { code: 'pass', entryPoint: 'answer', cases: exercise.cases },
      expect.any(Function),
    );
    expect(fetcher).not.toHaveBeenCalled();
    runner.dispose();
    expect(browser.dispose).toHaveBeenCalledOnce();
  });

  it.each(['browser-python', 'python', 'javascript', 'sql', 'shell'] as const)(
    'sends hosted %s to the API, never to the visitor’s localhost',
    async (runtime) => {
      vi.stubGlobal('location', { origin: 'https://corecode-omega.vercel.app' });
      const fetcher = vi.fn().mockResolvedValue(Response.json(result));
      vi.stubGlobal('fetch', fetcher);
      const runner = new PracticeRunner();
      expect(await runner.run({ ...exercise, runtime }, 'code', 'submit', '', vi.fn())).toEqual(
        result,
      );
      expect(browser.created).not.toHaveBeenCalled();
      const [path, options] = fetcher.mock.calls[0];
      expect(path).toBe('/api/run');
      expect(JSON.parse(options.body)).toEqual({
        problemId: exercise.id,
        problemVersion: exercise.version,
        code: 'code',
        mode: 'submit',
      });
    },
  );

  it('keeps custom input ungraded and sends no browser-supplied spec', async () => {
    vi.stubGlobal('location', { origin: 'https://corecode-omega.vercel.app' });
    const fetcher = vi.fn().mockResolvedValue(Response.json(result));
    vi.stubGlobal('fetch', fetcher);
    await new PracticeRunner().run(exercise, 'code', 'custom', '(4,)', vi.fn());
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      problemId: exercise.id,
      problemVersion: exercise.version,
      code: 'code',
      mode: 'custom',
      customArgs: '(4,)',
    });
  });

  it('shows a useful error when deployment protection requires sign-in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('private html', { status: 401 })),
    );
    await expect(new PracticeRunner().run(exercise, 'pass', 'submit', '', vi.fn())).rejects.toThrow(
      'sign in again',
    );
  });

  it('does not render a raw HTML upstream error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>private html</html>')));
    await expect(new PracticeRunner().run(exercise, 'pass', 'submit', '', vi.fn())).rejects.toThrow(
      'code execution API is unavailable',
    );
  });

  it('aborts only the active request when canceled', async () => {
    let observed: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_path, options) => {
        observed = options.signal;
        return new Promise((_resolve, reject) =>
          observed!.addEventListener('abort', () => reject(new Error('Canceled')), { once: true }),
        );
      }),
    );
    const runner = new PracticeRunner();
    const pending = runner.run(exercise, 'pass', 'submit', '', vi.fn());
    runner.cancel();
    expect(observed?.aborted).toBe(true);
    await expect(pending).rejects.toThrow('Canceled');
  });

  it.each([
    ['http://127.0.0.1:5173', 25_000],
    ['https://corecode-omega.vercel.app', 165_000],
  ] as const)('bounds requests from %s at %i ms', async (origin, timeoutMs) => {
    vi.useFakeTimers();
    vi.stubGlobal('location', { origin });
    let observed: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_path, options) => {
        observed = options.signal;
        return new Promise((_resolve, reject) =>
          observed!.addEventListener('abort', () => reject(new Error('Timed out')), {
            once: true,
          }),
        );
      }),
    );
    const pending = new PracticeRunner().run(
      { ...exercise, runtime: 'python' },
      'pass',
      'submit',
      '',
      vi.fn(),
    );
    const rejected = expect(pending).rejects.toThrow('Timed out');
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(observed?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(observed?.aborted).toBe(true);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    expect(browser.created).not.toHaveBeenCalled();
  });
});
