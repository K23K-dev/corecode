import {
  fields,
  identifier as progressIdentifier,
  MAX_BACKUP_BYTES,
  MAX_CODE_BYTES,
  MAX_EXERCISES,
  MAX_ATTEMPTS_PER_EXERCISE,
  nonnegativeInteger,
  plainObject as progressObject,
  ProgressValidationError,
  validateProgress,
  type Attempt,
  type ProgressData,
} from '../shared/progress.ts';

export type CompletionChange = { id: string; value: boolean };

export type ArchivedSubmission = {
  exerciseId: string;
  attempt: Attempt & { problemVersion: string | null };
};

export type StateUpdate = {
  expectedRevision: number;
  progress: ProgressData;
  stars: string[];
  submissions: ArchivedSubmission[];
  migrationId: string | undefined;
  writeIds: string[];
  solvedChanges: Record<string, CompletionChange>;
};

export { MAX_CODE_BYTES, MAX_EXERCISES };
export const MAX_BODY_BYTES = MAX_BACKUP_BYTES;
export const MAX_VISIBLE_ATTEMPTS = MAX_ATTEMPTS_PER_EXERCISE;

export class RequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status = 400, code = 'invalid_request') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(message: string): never {
  throw new RequestError(message);
}

function requestValidator<Args extends unknown[], Result>(validate: (...args: Args) => Result) {
  return (...args: Args): Result => {
    try {
      return validate(...args);
    } catch (error) {
      if (error instanceof ProgressValidationError) throw new RequestError(error.message);
      throw error;
    }
  };
}

export const plainObject = requestValidator(progressObject);
export const identifier = requestValidator(progressIdentifier);

/** Retains every validated attempt for archival; only the UI snapshot is capped. */
export const validateStateUpdate = requestValidator((value: unknown): StateUpdate => {
  const root = plainObject(value, 'Save request');
  fields(
    root,
    ['expectedRevision', 'progress', 'stars'],
    ['migrationId', 'writeIds', 'solvedChanges'],
    'Save request',
  );
  const expectedRevision = nonnegativeInteger(root.expectedRevision, 'Expected revision');
  if (expectedRevision >= Number.MAX_SAFE_INTEGER) fail('Expected revision is out of range.');
  const visible = validateProgress(root.progress, { retainAttempts: true });
  const submissions: ArchivedSubmission[] = [];
  for (const [exerciseId, entry] of Object.entries(visible.exercises)) {
    for (const attempt of entry.attempts) {
      submissions.push({
        exerciseId,
        attempt: { ...attempt, problemVersion: attempt.problemVersion ?? null },
      });
    }
    entry.attempts = entry.attempts.slice(-MAX_VISIBLE_ATTEMPTS);
  }
  if (!Array.isArray(root.stars) || root.stars.length > MAX_EXERCISES)
    fail('Stars must contain at most 1,000 identifiers.');
  const stars = [
    ...new Set(root.stars.map((id: unknown) => identifier(id, 'Starred exercise ID'))),
  ];
  const migrationId =
    root.migrationId === undefined ? undefined : identifier(root.migrationId, 'Migration ID');
  if (root.writeIds !== undefined && (!Array.isArray(root.writeIds) || root.writeIds.length > 1000))
    fail('Write IDs must contain at most 1,000 identifiers.');
  const rawWriteIds: unknown[] = root.writeIds === undefined ? [] : root.writeIds;
  const writeIds = [...new Set(rawWriteIds.map((id) => identifier(id, 'Write ID')))];
  const solvedChanges: Record<string, CompletionChange> = Object.create(null);
  const choiceIds = new Set<string>();
  for (const [rawId, rawChange] of Object.entries(
    plainObject(root.solvedChanges ?? {}, 'Completion changes'),
  )) {
    const exerciseId = identifier(rawId, 'Exercise ID');
    const change = plainObject(rawChange, 'Completion change');
    fields(change, ['id', 'value'], [], 'Completion change');
    const id = identifier(change.id, 'Completion change ID');
    if (
      typeof change.value !== 'boolean' ||
      !visible.exercises[exerciseId] ||
      visible.exercises[exerciseId].solved !== change.value ||
      !writeIds.includes(id) ||
      choiceIds.has(id)
    )
      fail('Completion changes must match progress and have unique write IDs.');
    choiceIds.add(id);
    solvedChanges[exerciseId] = { id, value: change.value };
  }
  return {
    expectedRevision,
    progress: visible,
    stars,
    submissions,
    migrationId,
    writeIds,
    solvedChanges,
  };
});

export function stableJson(value: Record<string, unknown> | readonly unknown[]): string;
export function stableJson(value: unknown): string | undefined;
export function stableJson(value: unknown): string | undefined {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
