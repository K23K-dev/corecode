import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Exercise } from '../src/lib/exercises';
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
  it.each(['browser-python', undefined] as const)(
    'sends local runtime %s to the private API without browser-provided grading data',
    async (runtime) => {
      vi.stubGlobal('location', { origin: 'http://127.0.0.1:5173' });
      const fetcher = vi.fn().mockResolvedValue(Response.json(result));
      vi.stubGlobal('fetch', fetcher);
      const runner = new PracticeRunner();
      expect(await runner.run({ ...exercise, runtime }, 'pass', 'submit')).toEqual(result);
      expect(fetcher).toHaveBeenCalledOnce();
      const [path, options] = fetcher.mock.calls[0];
      expect(path).toBe('/api/run');
      expect(options.method).toBe('POST');
      expect(options.headers).toEqual({
        'Content-Type': 'application/json',
        'X-Code-Practice-Client': '1',
      });
      expect(JSON.parse(options.body)).toEqual({
        problemId: exercise.id,
        problemVersion: exercise.version,
        code: 'pass',
        mode: 'submit',
      });
      runner.cancel();
      expect(options.signal.aborted).toBe(false);
    },
  );

  it.each(['browser-python', 'python', 'javascript', 'sql', 'shell'] as const)(
    'sends hosted %s to the API, never to the visitor’s localhost',
    async (runtime) => {
      vi.stubGlobal('location', { origin: 'https://corecode-omega.vercel.app' });
      const fetcher = vi.fn().mockResolvedValue(Response.json(result));
      vi.stubGlobal('fetch', fetcher);
      const runner = new PracticeRunner();
      expect(await runner.run({ ...exercise, runtime }, 'code', 'submit')).toEqual(result);
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

  it.each(['http://127.0.0.1:5173', 'https://corecode-omega.vercel.app'])(
    'runs authored examples without browser-supplied specs from %s',
    async (origin) => {
      vi.stubGlobal('location', { origin });
      const exampleResult = {
        ...result,
        cases: [{ name: 'Example', input: '(1,)', actual: '2', passed: true, expected: '2' }],
      };
      const fetcher = vi.fn().mockResolvedValue(Response.json(exampleResult));
      vi.stubGlobal('fetch', fetcher);
      expect(await new PracticeRunner().run(exercise, 'code', 'example')).toEqual(exampleResult);
      expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
        problemId: exercise.id,
        problemVersion: exercise.version,
        code: 'code',
        mode: 'example',
      });
    },
  );

  it('shows a useful error when deployment protection requires sign-in', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('private html', { status: 401 })),
    );
    await expect(new PracticeRunner().run(exercise, 'pass', 'submit')).rejects.toThrow(
      'sign in again',
    );
  });

  it('does not render a raw HTML upstream error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>private html</html>')));
    await expect(new PracticeRunner().run(exercise, 'pass', 'submit')).rejects.toThrow(
      'code execution API is unavailable',
    );
  });

  it('aborts the active request on cancel', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('location', { origin: 'http://127.0.0.1:5173' });
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
    const pending = runner.run(exercise, 'pass', 'submit');
    runner.cancel();
    expect(observed?.aborted).toBe(true);
    await expect(pending).rejects.toThrow('Canceled');
    expect(vi.getTimerCount()).toBe(0);
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
    const pending = new PracticeRunner().run(exercise, 'pass', 'submit');
    const rejected = expect(pending).rejects.toThrow('Timed out');
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(observed?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(observed?.aborted).toBe(true);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
