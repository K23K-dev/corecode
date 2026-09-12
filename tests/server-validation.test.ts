import { describe, expect, it } from 'vitest';
// The runtime module is native Node.js ESM; dynamic loading keeps these tests on that same interface.
const validationModule = '../server/validation.mjs';
const { MAX_CODE_BYTES, stableJson, validateStateUpdate } = await import(validationModule);

function attempt(id = 'attempt-1') {
  return {
    id,
    at: '2026-09-08T12:00:00.000Z',
    code: 'def solve(x):\n    return x\n',
    passed: 1,
    total: 1,
    status: 'accepted',
    durationMs: 1.25,
  };
}

function update(attempts: unknown[] = [attempt()]) {
  return {
    expectedRevision: 0,
    progress: {
      version: 1,
      exercises: {
        'legacy-unknown-problem': {
          draft: 'draft',
          updatedAt: '2026-09-08T12:00:00Z',
          solved: true,
          attempts,
        },
      },
    },
    stars: ['legacy-star'],
  };
}

describe('database save validation', () => {
  it('preserves unknown legacy IDs and stars without filtering against the current catalog', () => {
    const result = validateStateUpdate(update());
    expect(Object.keys(result.progress.exercises)).toEqual(['legacy-unknown-problem']);
    expect(result.stars).toEqual(['legacy-star']);
    expect(result.submissions[0].attempt.problemVersion).toBeNull();
    expect(result.progress.exercises['legacy-unknown-problem'].attempts[0]).not.toHaveProperty(
      'problemVersion',
    );
  });

  it('archives all supplied attempts but keeps only the latest 20 in the visible snapshot', () => {
    const entries = Array.from({ length: 31 }, (_, index) => attempt(`attempt-${index}`));
    const result = validateStateUpdate(update(entries));
    expect(result.submissions).toHaveLength(31);
    expect(result.progress.exercises['legacy-unknown-problem'].attempts).toEqual(
      entries.slice(-20),
    );
  });

  it('preserves a reported version and accepts explicit legacy null', () => {
    const version = 'a'.repeat(64);
    const result = validateStateUpdate(update([{ ...attempt(), problemVersion: version }]));
    expect(result.submissions[0].attempt.problemVersion).toBe(version);
    const legacy = validateStateUpdate(update([{ ...attempt(), problemVersion: null }]));
    expect(
      legacy.progress.exercises['legacy-unknown-problem'].attempts[0].problemVersion,
    ).toBeNull();
  });

  it('validates optional durable migration receipts and deduplicates stars', () => {
    const result = validateStateUpdate({
      ...update(),
      stars: ['legacy-star', 'legacy-star'],
      migrationId: 'browser-migration-1',
    });
    expect(result.migrationId).toBe('browser-migration-1');
    expect(result.stars).toEqual(['legacy-star']);
    expect(() => validateStateUpdate({ ...update(), migrationId: '' })).toThrow();
  });

  it('validates bounded write receipts without restricting them to current problem IDs', () => {
    const result = validateStateUpdate({
      ...update(),
      writeIds: ['star-operation-1', 'star-operation-1'],
    });
    expect(result.writeIds).toEqual(['star-operation-1']);
    expect(() => validateStateUpdate({ ...update(), writeIds: ['constructor'] })).toThrow();
    expect(() =>
      validateStateUpdate({ ...update(), writeIds: Array(1001).fill('operation') }),
    ).toThrow();
    expect(() =>
      validateStateUpdate(update([{ ...attempt(), problemVersion: 'not-a-hash' }])),
    ).toThrow();
  });

  it('rejects unsafe object keys and identifiers', () => {
    const unsafe = JSON.parse(
      '{"expectedRevision":0,"progress":{"version":1,"exercises":{"__proto__":{}}},"stars":[]}',
    );
    expect(() => validateStateUpdate(unsafe)).toThrow();
    expect(() => validateStateUpdate({ ...update(), stars: ['constructor'] })).toThrow();
  });

  it('rejects unknown fields, invalid revisions, and malformed submission results', () => {
    expect(() => validateStateUpdate({ ...update(), expectedRevision: -1 })).toThrow();
    expect(() =>
      validateStateUpdate({ ...update(), expectedRevision: Number.MAX_SAFE_INTEGER }),
    ).toThrow();
    expect(() => validateStateUpdate({ ...update(), extra: true })).toThrow();
    for (const change of [
      { passed: 2 },
      { total: 0 },
      { status: 'maybe' },
      { durationMs: Infinity },
      { at: '2026-02-30T12:00:00Z' },
    ]) {
      expect(() => validateStateUpdate(update([{ ...attempt(), ...change }]))).toThrow();
    }
  });

  it('rejects duplicate submission identities across the complete request', () => {
    expect(() => validateStateUpdate(update([attempt(), attempt()]))).toThrow();
    const source = update();
    const progress = {
      ...source.progress,
      exercises: {
        ...source.progress.exercises,
        'another-problem': source.progress.exercises['legacy-unknown-problem'],
      },
    };
    expect(() => validateStateUpdate({ ...source, progress })).toThrow();
  });

  it('enforces UTF-8 code bounds and rejects PostgreSQL-incompatible strings', () => {
    const source = update();
    const exercise = source.progress.exercises['legacy-unknown-problem'];
    exercise.draft = 'a'.repeat(MAX_CODE_BYTES);
    expect(() => validateStateUpdate(source)).not.toThrow();
    exercise.draft += 'a';
    expect(() => validateStateUpdate(source)).toThrow();
    exercise.draft = 'x\0y';
    expect(() => validateStateUpdate(source)).toThrow();
    exercise.draft = '\uD800';
    expect(() => validateStateUpdate(source)).toThrow();
    exercise.draft = '😀';
    expect(() => validateStateUpdate(source)).not.toThrow();
  });

  it('canonicalizes content hashes independently of JSON object key order', () => {
    expect(stableJson({ b: [2, { z: 1, a: true }], a: 0 })).toBe(
      stableJson({ a: 0, b: [2, { a: true, z: 1 }] }),
    );
    expect(stableJson([1, 2])).not.toBe(stableJson([2, 1]));
  });
});
