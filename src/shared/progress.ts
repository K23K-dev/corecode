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

export const MAX_ATTEMPTS_PER_EXERCISE = 20;
export const MAX_CODE_BYTES = 50 * 1024;
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
export const MAX_EXERCISES = 1000;

const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);
const encoder = new TextEncoder();

export class ProgressValidationError extends Error {}

function fail(message: string): never {
  throw new ProgressValidationError(message);
}

export function fitsBytes(value: string, limit: number): boolean {
  return value.length <= limit && encoder.encode(value).byteLength <= limit;
}

export function plainObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be a plain object.`);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN.has(key)) fail(`${label} contains an unsafe property.`);
  }
  return value as Record<string, unknown>;
}

export function fields(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
  label: string,
): void {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing the ${key} field.`);
  }
  if (Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)))
    fail(`${label} contains an unrecognized field.`);
}

function validText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== 'string') fail(`${label} must be text.`);
  if (value.includes('\0') || /[\uD800-\uDFFF]/u.test(value))
    fail(`${label} contains invalid Unicode.`);
  if (!fitsBytes(value, maxBytes)) fail(`${label} exceeds its size limit.`);
  return value;
}

export function identifier(value: unknown, label = 'Identifier'): string {
  const text = validText(value, label, 800);
  if (!text.trim() || text.length > 200 || FORBIDDEN.has(text))
    fail(`${label} must be a safe identifier of at most 200 characters.`);
  return text;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  )
    fail(`${label} must be a valid UTC ISO timestamp.`);
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    fail(`${label} must be a valid UTC ISO timestamp.`);
  return value;
}

export function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    fail(`${label} must be a nonnegative integer.`);
  return value;
}

function validateAttempt(value: unknown, label: string): Attempt {
  const item = plainObject(value, label);
  fields(
    item,
    ['id', 'at', 'code', 'passed', 'total', 'status', 'durationMs'],
    ['problemVersion'],
    label,
  );
  const passed = nonnegativeInteger(item.passed, `${label} passed count`);
  const total = nonnegativeInteger(item.total, `${label} total count`);
  if (passed > total) fail(`${label} cannot pass more tests than its total.`);
  if (item.status !== 'accepted' && item.status !== 'failed' && item.status !== 'error')
    fail(`${label} has an unknown result status.`);
  if (item.status === 'accepted' && (total === 0 || passed !== total))
    fail(`${label} can be accepted only when all tests passed.`);
  if (
    typeof item.durationMs !== 'number' ||
    !Number.isFinite(item.durationMs) ||
    item.durationMs < 0
  )
    fail(`${label} duration must be a finite, nonnegative number.`);
  const result: Attempt = {
    id: identifier(item.id, `${label} ID`),
    at: timestamp(item.at, `${label} date`),
    code: validText(item.code, `${label} code`, MAX_CODE_BYTES),
    passed,
    total,
    status: item.status,
    durationMs: item.durationMs,
  };
  if (Object.hasOwn(item, 'problemVersion')) {
    if (
      item.problemVersion !== null &&
      (typeof item.problemVersion !== 'string' || !/^[a-f0-9]{64}$/.test(item.problemVersion))
    )
      fail(`${label} has an invalid problem version.`);
    result.problemVersion = item.problemVersion;
  }
  return result;
}

/** Validate every attempt before limiting a UI snapshot; imports can retain the full archive. */
export function validateProgress(
  value: unknown,
  { retainAttempts = false, label = 'Progress' }: { retainAttempts?: boolean; label?: string } = {},
): ProgressData {
  const root = plainObject(value, label);
  fields(root, ['version', 'exercises'], [], label);
  if (root.version !== 1)
    fail(`Unsupported ${label.toLowerCase()} version. This app supports version 1 only.`);
  const source = plainObject(root.exercises, 'Exercise progress');
  if (Object.keys(source).length > MAX_EXERCISES)
    fail(`${label} exceeds the limit of 1,000 exercises.`);
  const progress: ProgressData = { version: 1, exercises: Object.create(null) };
  const seen = new Set<string>();
  for (const [rawId, rawProgress] of Object.entries(source)) {
    const exerciseId = identifier(rawId, 'Exercise ID');
    const exerciseLabel = `Exercise ${exerciseId}`;
    const entry = plainObject(rawProgress, exerciseLabel);
    fields(entry, ['draft', 'updatedAt', 'solved', 'attempts'], [], exerciseLabel);
    if (typeof entry.solved !== 'boolean')
      fail(`${exerciseLabel} solved state must be true or false.`);
    if (!Array.isArray(entry.attempts)) fail(`${exerciseLabel} attempts must be an array.`);
    const attempts = Array.from(entry.attempts, (raw: unknown, index) => {
      const attempt = validateAttempt(raw, `${exerciseLabel} attempt ${index + 1}`);
      if (seen.has(attempt.id)) fail('Submission IDs must be unique throughout progress.');
      seen.add(attempt.id);
      return attempt;
    });
    progress.exercises[exerciseId] = {
      draft: validText(entry.draft, `${exerciseLabel} draft`, MAX_CODE_BYTES),
      updatedAt: timestamp(entry.updatedAt, `${exerciseLabel} update date`),
      solved: entry.solved,
      attempts: retainAttempts ? attempts : attempts.slice(-MAX_ATTEMPTS_PER_EXERCISE),
    };
  }
  return progress;
}
