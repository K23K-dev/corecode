import { describe, expect, it } from 'vitest';
import {
  exportProgress,
  MAX_ATTEMPTS_PER_EXERCISE,
  MAX_BACKUP_BYTES,
  MAX_CODE_BYTES,
  MAX_EXERCISES,
  parseProgressBackup,
  type Attempt,
  type ProgressData,
} from '../src/lib/progress';

const DATE = '2026-09-08T12:34:56.789Z';

function makeAttempt(index = 0): Attempt {
  return {
    id: `attempt-${index}`,
    at: DATE,
    code: `print(${index})`,
    passed: 1,
    total: 1,
    status: 'accepted',
    durationMs: 1.25,
  };
}

function makeProgress(): ProgressData {
  return {
    version: 1,
    exercises: {
      'python-example': {
        draft: "# Unsaved Unicode: café 🐍\nprint('hello')\n",
        updatedAt: DATE,
        solved: true,
        attempts: [makeAttempt()],
      },
    },
  };
}

describe('progress backups', () => {
  it('round-trips empty progress', () => {
    const data: ProgressData = { version: 1, exercises: {} };
    expect(parseProgressBackup(exportProgress(data))).toEqual(data);
  });

  it('round-trips drafts, solved state, dates and attempts', () => {
    const data = makeProgress();
    expect(parseProgressBackup(exportProgress(data))).toEqual(data);
  });

  it('rejects unsupported future backup versions', () => {
    expect(() => parseProgressBackup('{"version":2,"exercises":{}}')).toThrow(
      /unsupported.*version/i,
    );
  });

  it('keeps only the latest 20 attempts without mutating the input or draft', () => {
    const data = makeProgress();
    data.exercises['python-example'].attempts = Array.from({ length: 25 }, (_, index) =>
      makeAttempt(index),
    );
    const loaded = parseProgressBackup(exportProgress(data));
    const exercise = loaded.exercises['python-example'];
    expect(exercise.attempts).toHaveLength(MAX_ATTEMPTS_PER_EXERCISE);
    expect(exercise.attempts[0].id).toBe('attempt-5');
    expect(exercise.attempts.at(-1)?.id).toBe('attempt-24');
    expect(exercise.draft).toBe(data.exercises['python-example'].draft);
    expect(data.exercises['python-example'].attempts).toHaveLength(25);
  });

  it('applies the history cap to imported JSON too', () => {
    const data = makeProgress();
    data.exercises['python-example'].attempts = Array.from({ length: 21 }, (_, index) =>
      makeAttempt(index),
    );
    expect(
      parseProgressBackup(JSON.stringify(data)).exercises['python-example'].attempts[0].id,
    ).toBe('attempt-1');
  });

  it('does not hide corrupt old attempts while enforcing the history cap', () => {
    const data = makeProgress();
    data.exercises['python-example'].attempts = Array.from({ length: 21 }, (_, index) =>
      makeAttempt(index),
    );
    data.exercises['python-example'].attempts[0].total = -1;
    expect(() => parseProgressBackup(JSON.stringify(data))).toThrow(/nonnegative integer/i);
  });
});

describe('backup validation and safety limits', () => {
  it('returns a deep, prototype-safe copy', () => {
    const data = makeProgress();
    const loaded = parseProgressBackup(exportProgress(data));
    expect(Object.getPrototypeOf(loaded.exercises)).toBeNull();
    expect(loaded.exercises['python-example']).not.toBe(data.exercises['python-example']);
    expect(loaded.exercises['python-example'].attempts[0]).not.toBe(
      data.exercises['python-example'].attempts[0],
    );
  });

  it.each(['', '{', 'undefined'])('rejects invalid JSON %j', (text) => {
    expect(() => parseProgressBackup(text)).toThrow(/not valid JSON/i);
  });

  it.each(['null', '[]', '42', '"text"'])('rejects non-object roots %s', (text) => {
    expect(() => parseProgressBackup(text)).toThrow(/plain object/i);
  });

  it.each(['__proto__', 'prototype', 'constructor'])(
    'rejects unsafe key %s at every object level',
    (key) => {
      const base = JSON.stringify(makeProgress());
      expect(() => parseProgressBackup(`{"version":1,"exercises":{},"${key}":{}}`)).toThrow(
        /unsafe object key/i,
      );
      expect(() => parseProgressBackup(base.replace('"python-example":', `"${key}":`))).toThrow(
        /unsafe object key/i,
      );
      expect(() => parseProgressBackup(base.replace('"draft":', `"${key}":0,"draft":`))).toThrow(
        /unsafe object key/i,
      );
      expect(() => parseProgressBackup(base.replace('"id":', `"${key}":0,"id":`))).toThrow(
        /unsafe object key/i,
      );
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    },
  );

  it('rejects missing and unexpected fields', () => {
    expect(() => parseProgressBackup('{"version":1,"exercises":{},"extra":true}')).toThrow(
      /unrecognized field/i,
    );
    expect(() => parseProgressBackup('{"version":1}')).toThrow(/missing the exercises/i);
  });

  it('rejects duplicate attempt identifiers', () => {
    const data = makeProgress();
    data.exercises['python-example'].attempts.push(makeAttempt());
    expect(() => exportProgress(data)).toThrow(/duplicate attempt IDs/i);
  });

  it('accepts exact 50 KB code limits and rejects oversized drafts and attempt code', () => {
    const data = makeProgress();
    data.exercises['python-example'].draft = 'x'.repeat(MAX_CODE_BYTES);
    expect(
      parseProgressBackup(exportProgress(data)).exercises['python-example'].draft,
    ).toHaveLength(MAX_CODE_BYTES);
    data.exercises['python-example'].draft += 'x';
    expect(() => exportProgress(data)).toThrow(/draft exceeds the 50 KB/i);
    data.exercises['python-example'].draft = '';
    data.exercises['python-example'].attempts[0].code = 'x'.repeat(MAX_CODE_BYTES + 1);
    expect(() => exportProgress(data)).toThrow(/code exceeds the 50 KB/i);
  });

  it('counts UTF-8 bytes instead of JavaScript characters', () => {
    const data = makeProgress();
    data.exercises['python-example'].draft = 'é'.repeat(MAX_CODE_BYTES / 2 + 1);
    expect(() => exportProgress(data)).toThrow(/50 KB/i);
  });

  it('rejects oversized input before parsing JSON', () => {
    expect(() => parseProgressBackup(' '.repeat(MAX_BACKUP_BYTES + 1))).toThrow(/10 MB/i);
  });

  it('caps exported backups at 10 MB even when individual drafts fit', () => {
    const template = {
      ...makeProgress().exercises['python-example'],
      draft: 'x'.repeat(11_000),
      attempts: [],
    };
    const data: ProgressData = {
      version: 1,
      exercises: Object.fromEntries(
        Array.from({ length: 1000 }, (_, index) => [`exercise-${index}`, template]),
      ),
    };
    expect(() => exportProgress(data)).toThrow(/10 MB/i);
  });

  it('accepts 1,000 exercises but rejects 1,001', () => {
    const template = { ...makeProgress().exercises['python-example'], attempts: [] };
    const data: ProgressData = {
      version: 1,
      exercises: Object.fromEntries(
        Array.from({ length: MAX_EXERCISES }, (_, index) => [`exercise-${index}`, template]),
      ),
    };
    expect(Object.keys(parseProgressBackup(exportProgress(data)).exercises)).toHaveLength(
      MAX_EXERCISES,
    );
    data.exercises.extra = template;
    expect(() => exportProgress(data)).toThrow(/1,000 exercises/i);
  });

  it.each([
    ['at', 'not a date'],
    ['at', '2026-02-30T12:34:56.000Z'],
    ['passed', -1],
    ['passed', 0.5],
    ['passed', 2],
    ['total', '1'],
    ['status', 'unknown'],
    ['durationMs', -1],
    ['id', ''],
  ])('rejects invalid attempt %s=%j', (field, value) => {
    const data = makeProgress();
    (data.exercises['python-example'].attempts[0] as unknown as Record<string, unknown>)[field] =
      value;
    expect(() => exportProgress(data)).toThrow();
  });

  it('rejects non-finite durations and impossible accepted results', () => {
    const data = makeProgress();
    data.exercises['python-example'].attempts[0].durationMs = Number.POSITIVE_INFINITY;
    expect(() => exportProgress(data)).toThrow(/finite/i);
    data.exercises['python-example'].attempts[0].durationMs = 0;
    data.exercises['python-example'].attempts[0].passed = 0;
    expect(() => exportProgress(data)).toThrow(/all tests passed/i);
  });

  it('accepts failed and error attempts with zero passed tests', () => {
    const data = makeProgress();
    const attempt = data.exercises['python-example'].attempts[0];
    attempt.status = 'failed';
    attempt.passed = 0;
    expect(
      parseProgressBackup(exportProgress(data)).exercises['python-example'].attempts[0].status,
    ).toBe('failed');
    attempt.status = 'error';
    attempt.total = 0;
    expect(
      parseProgressBackup(exportProgress(data)).exercises['python-example'].attempts[0].status,
    ).toBe('error');
  });
});
