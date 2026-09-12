/** Versioned progress. Attempts are ordered oldest to newest. */
export type Attempt = {
  id: string;
  at: string;
  code: string;
  passed: number;
  total: number;
  status: 'accepted' | 'failed' | 'error';
  durationMs: number;
  problemVersion?: string | null;
};

export type ExerciseProgress = {
  draft: string;
  updatedAt: string;
  solved: boolean;
  attempts: Attempt[];
};

export type ProgressData = {
  version: 1;
  exercises: Record<string, ExerciseProgress>;
};

/** Minimal storage interface for browser migration and recovery. */
export interface ProgressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const PROGRESS_STORAGE_KEY = 'coding-practice:progress:v1';
export const MAX_ATTEMPTS_PER_EXERCISE = 20;
export const MAX_CODE_BYTES = 50 * 1024;
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
export const MAX_EXERCISES = 1000;

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
function emptyProgress(): ProgressData {
  return { version: 1, exercises: Object.create(null) as Record<string, ExerciseProgress> };
}

function fail(message: string): never {
  throw new Error(message);
}

function fitsBytes(value: string, limit: number): boolean {
  // UTF-8 uses at least one byte per UTF-16 code unit for valid JS strings.
  return value.length <= limit && new TextEncoder().encode(value).byteLength <= limit;
}

function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be a plain object.`);
  }
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      fail(`${label} contains an unsafe object key.`);
    }
  }
  return value as Record<string, unknown>;
}

function fields(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing the ${key} field.`);
  }
  if (Object.keys(value).some((key) => !expected.includes(key))) {
    fail(`${label} contains an unrecognized field.`);
  }
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 200 ||
    FORBIDDEN_KEYS.has(value)
  ) {
    fail(`${label} must be a nonempty, safe identifier of at most 200 characters.`);
  }
  return value;
}

function code(value: unknown, label: string): string {
  if (typeof value !== 'string') fail(`${label} must be text.`);
  if (!fitsBytes(value, MAX_CODE_BYTES)) fail(`${label} exceeds the 50 KB code limit.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  // Accept the UTC ISO strings the app exports, with or without milliseconds.
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  ) {
    fail(`${label} must be a valid UTC ISO timestamp.`);
  }
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    fail(`${label} must be a valid UTC ISO timestamp.`);
  }
  return value;
}

function count(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    fail(`${label} must be a nonnegative integer.`);
  }
  return value;
}

function attempt(value: unknown, label: string): Attempt {
  const item = plainObject(value, label);
  fields(
    item,
    [
      'id',
      'at',
      'code',
      'passed',
      'total',
      'status',
      'durationMs',
      ...(Object.hasOwn(item, 'problemVersion') ? ['problemVersion'] : []),
    ],
    label,
  );
  if (
    item.problemVersion !== undefined &&
    item.problemVersion !== null &&
    (typeof item.problemVersion !== 'string' || !/^[a-f0-9]{64}$/.test(item.problemVersion))
  )
    fail(`${label} has an invalid problem version.`);
  const passed = count(item.passed, `${label} passed count`);
  const total = count(item.total, `${label} total count`);
  if (passed > total) fail(`${label} cannot pass more tests than its total.`);
  const status = item.status;
  if (status !== 'accepted' && status !== 'failed' && status !== 'error') {
    fail(`${label} has an unknown result status.`);
  }
  if (status === 'accepted' && (total === 0 || passed !== total)) {
    fail(`${label} can be accepted only when all tests passed.`);
  }
  if (
    typeof item.durationMs !== 'number' ||
    !Number.isFinite(item.durationMs) ||
    item.durationMs < 0
  ) {
    fail(`${label} duration must be a finite, nonnegative number.`);
  }
  return {
    id: identifier(item.id, `${label} ID`),
    at: timestamp(item.at, `${label} date`),
    code: code(item.code, `${label} code`),
    passed,
    total,
    status,
    durationMs: item.durationMs,
    ...(Object.hasOwn(item, 'problemVersion')
      ? { problemVersion: item.problemVersion as string | null }
      : {}),
  };
}

function validatedProgress(value: unknown, retainAttempts = false): ProgressData {
  const root = plainObject(value, 'Progress backup');
  fields(root, ['version', 'exercises'], 'Progress backup');
  if (root.version !== 1)
    fail('Unsupported progress backup version. This app supports version 1 only.');
  const exercises = plainObject(root.exercises, 'Exercises');
  const ids = Object.keys(exercises);
  if (ids.length > MAX_EXERCISES) fail('Progress backup exceeds the limit of 1,000 exercises.');
  const result = emptyProgress();
  for (const rawId of ids) {
    const id = identifier(rawId, 'Exercise ID');
    const label = `Exercise ${id}`;
    const item = plainObject(exercises[id], label);
    fields(item, ['draft', 'updatedAt', 'solved', 'attempts'], label);
    if (typeof item.solved !== 'boolean') fail(`${label} solved state must be true or false.`);
    if (!Array.isArray(item.attempts)) fail(`${label} attempts must be an array.`);
    const seen = new Set<string>();
    const attempts: Attempt[] = [];
    // Validate old entries before dropping them, rather than hiding corruption.
    for (let index = 0; index < item.attempts.length; index += 1) {
      const entry = attempt(item.attempts[index], `${label} attempt ${index + 1}`);
      if (seen.has(entry.id)) fail(`${label} contains duplicate attempt IDs.`);
      seen.add(entry.id);
      if (retainAttempts || index >= item.attempts.length - MAX_ATTEMPTS_PER_EXERCISE)
        attempts.push(entry);
    }
    result.exercises[id] = {
      draft: code(item.draft, `${label} draft`),
      updatedAt: timestamp(item.updatedAt, `${label} update date`),
      solved: item.solved,
      attempts,
    };
  }
  return result;
}

/** Validate and clone a backup. No storage is touched, even when parsing fails. */
export function parseProgressBackup(
  text: string,
  options: { retainAttempts?: boolean } = {},
): ProgressData {
  if (typeof text !== 'string') fail('Progress backup must be JSON text.');
  if (!fitsBytes(text, MAX_BACKUP_BYTES)) fail('Progress backup exceeds the 10 MB size limit.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail('Progress backup is not valid JSON.');
  }
  return validatedProgress(parsed, options.retainAttempts);
}

/** Export a validated copy, preserving the complete draft and latest 20 attempts. */
export function exportProgress(data: ProgressData): string {
  const serialized = JSON.stringify(validatedProgress(data), null, 2);
  if (!fitsBytes(serialized, MAX_BACKUP_BYTES))
    fail('Progress backup exceeds the 10 MB size limit.');
  return serialized;
}
