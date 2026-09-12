export const MAX_BODY_BYTES = 10 * 1024 * 1024;
export const MAX_CODE_BYTES = 50 * 1024;
export const MAX_EXERCISES = 1000;
export const MAX_VISIBLE_ATTEMPTS = 20;
const FORBIDDEN = new Set(['__proto__', 'prototype', 'constructor']);

export class RequestError extends Error {
  constructor(message, status = 400, code = 'invalid_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(message) {
  throw new RequestError(message);
}

export function plainObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be a plain object.`);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN.has(key)) fail(`${label} contains an unsafe property.`);
  }
  return value;
}

function fields(value, required, optional, label) {
  if (required.some((key) => !Object.hasOwn(value, key)))
    fail(`${label} is missing a required field.`);
  if (Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)))
    fail(`${label} contains an unrecognized field.`);
}

function validText(value, label, maxBytes) {
  if (typeof value !== 'string') fail(`${label} must be text.`);
  if (value.includes('\0') || /[\uD800-\uDFFF]/u.test(value))
    fail(`${label} contains invalid Unicode.`);
  if (value.length > maxBytes || Buffer.byteLength(value, 'utf8') > maxBytes)
    fail(`${label} exceeds its size limit.`);
  return value;
}

export function identifier(value, label = 'Identifier') {
  validText(value, label, 800);
  if (!value.trim() || value.length > 200 || FORBIDDEN.has(value))
    fail(`${label} must be a safe identifier of at most 200 characters.`);
  return value;
}

function timestamp(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
  )
    fail('Invalid submission or progress date.');
  const parsed = new Date(value);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 19) !== value.slice(0, 19)
  )
    fail('Invalid submission or progress date.');
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) fail(`${label} must be a nonnegative integer.`);
  return value;
}

function validateAttempt(value) {
  const item = plainObject(value, 'Submission');
  fields(
    item,
    ['id', 'at', 'code', 'passed', 'total', 'status', 'durationMs'],
    ['problemVersion'],
    'Submission',
  );
  const passed = nonnegativeInteger(item.passed, 'Passed count');
  const total = nonnegativeInteger(item.total, 'Total count');
  if (passed > total) fail('A submission cannot pass more cases than its total.');
  if (!['accepted', 'failed', 'error'].includes(item.status)) fail('Invalid submission status.');
  if (item.status === 'accepted' && (total === 0 || passed !== total))
    fail('An accepted submission must pass every case.');
  if (
    typeof item.durationMs !== 'number' ||
    !Number.isFinite(item.durationMs) ||
    item.durationMs < 0
  )
    fail('Invalid submission duration.');
  const result = {
    id: identifier(item.id, 'Submission ID'),
    at: timestamp(item.at),
    code: validText(item.code, 'Submission code', MAX_CODE_BYTES),
    passed,
    total,
    status: item.status,
    durationMs: item.durationMs,
  };
  if (Object.hasOwn(item, 'problemVersion')) {
    if (
      item.problemVersion !== null &&
      (typeof item.problemVersion !== 'string' || !/^[a-f0-9]{64}$/.test(item.problemVersion))
    ) {
      fail('Problem version must be a SHA-256 hash or null for legacy submissions.');
    }
    result.problemVersion = item.problemVersion;
  }
  return result;
}

/** Retains every validated attempt for archival; only the UI snapshot is capped. */
export function validateStateUpdate(value) {
  const root = plainObject(value, 'Save request');
  fields(
    root,
    ['expectedRevision', 'progress', 'stars'],
    ['migrationId', 'writeIds'],
    'Save request',
  );
  const expectedRevision = nonnegativeInteger(root.expectedRevision, 'Expected revision');
  if (expectedRevision >= Number.MAX_SAFE_INTEGER) fail('Expected revision is out of range.');
  const progress = plainObject(root.progress, 'Progress');
  fields(progress, ['version', 'exercises'], [], 'Progress');
  if (progress.version !== 1) fail('Unsupported progress version.');
  const source = plainObject(progress.exercises, 'Exercise progress');
  if (Object.keys(source).length > MAX_EXERCISES) fail('Progress exceeds 1,000 exercises.');
  const visible = { version: 1, exercises: Object.create(null) };
  const submissions = [];
  const seen = new Set();
  for (const [rawId, rawProgress] of Object.entries(source)) {
    const exerciseId = identifier(rawId, 'Exercise ID');
    const entry = plainObject(rawProgress, 'Exercise progress');
    fields(entry, ['draft', 'updatedAt', 'solved', 'attempts'], [], 'Exercise progress');
    if (typeof entry.solved !== 'boolean') fail('Solved state must be true or false.');
    if (!Array.isArray(entry.attempts)) fail('Attempts must be an array.');
    const attempts = entry.attempts.map((raw) => {
      const attempt = validateAttempt(raw);
      if (seen.has(attempt.id)) fail('Submission IDs must be unique throughout a save request.');
      seen.add(attempt.id);
      submissions.push({
        exerciseId,
        attempt: { ...attempt, problemVersion: attempt.problemVersion ?? null },
      });
      return attempt;
    });
    visible.exercises[exerciseId] = {
      draft: validText(entry.draft, 'Draft', MAX_CODE_BYTES),
      updatedAt: timestamp(entry.updatedAt),
      solved: entry.solved,
      attempts: attempts.slice(-MAX_VISIBLE_ATTEMPTS),
    };
  }
  if (!Array.isArray(root.stars) || root.stars.length > MAX_EXERCISES)
    fail('Stars must contain at most 1,000 identifiers.');
  const stars = [...new Set(root.stars.map((id) => identifier(id, 'Starred exercise ID')))];
  const migrationId =
    root.migrationId === undefined ? undefined : identifier(root.migrationId, 'Migration ID');
  if (root.writeIds !== undefined && (!Array.isArray(root.writeIds) || root.writeIds.length > 1000))
    fail('Write IDs must contain at most 1,000 identifiers.');
  const writeIds = [...new Set((root.writeIds ?? []).map((id) => identifier(id, 'Write ID')))];
  return { expectedRevision, progress: visible, stars, submissions, migrationId, writeIds };
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
