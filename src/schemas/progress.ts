import { z } from 'zod';

const MAX_ATTEMPTS_PER_EXERCISE = 20;
export const MAX_CODE_BYTES = 50 * 1024;
export const MAX_CODE_CHARACTERS = 32_768;
export const MAX_PROGRESS_BYTES = 10 * 1024 * 1024;
export const MAX_PROBLEMS = 1000;

const encoder = new TextEncoder();
function fitsBytes(value: string, limit: number): boolean {
  return value.length <= limit && encoder.encode(value).byteLength <= limit;
}

const validText = z
  .string()
  .refine(
    (value) => !value.includes('\0') && !/[\uD800-\uDFFF]/u.test(value),
    'Text contains invalid Unicode.',
  );
export const Identifier = validText
  .max(200)
  .refine(
    (value) =>
      value.trim().length > 0 && !['__proto__', 'prototype', 'constructor'].includes(value),
    'Invalid identifier.',
  );
export const CodeText = validText.refine(
  (value) => fitsBytes(value, MAX_CODE_BYTES),
  'Keep code under 50 KiB.',
);
export const ProblemVersion = z.string().regex(/^[a-f0-9]{64}$/);
export const Timestamp = z.iso.datetime().regex(/\.\d{1,3}Z$|:\d{2}Z$/);
const count = z.int().nonnegative();

const AttemptSchema = z
  .strictObject({
    id: Identifier,
    at: Timestamp,
    code: CodeText,
    passed: count,
    total: count,
    status: z.enum(['accepted', 'failed', 'error']),
    durationMs: z.number().nonnegative(),
    problemVersion: ProblemVersion.nullable().optional(),
  })
  .refine(
    ({ passed, total, status }) =>
      passed <= total && (status !== 'accepted' || (total > 0 && passed === total)),
    'Accepted submissions must pass every case.',
  );
const ProblemProgressSchema = z.strictObject({
  draft: CodeText,
  updatedAt: Timestamp,
  solved: z.boolean(),
  attempts: z.array(AttemptSchema).max(MAX_ATTEMPTS_PER_EXERCISE),
});
const problemMap = <T extends z.ZodType>(value: T) =>
  z
    .record(Identifier, value)
    .refine((items) => Object.keys(items).length <= MAX_PROBLEMS, 'Too many saved problems.');
const ProgressSchema = z
  .strictObject({
    version: z.literal(1),
    // Each problem's saved entry. Renaming "exercises" would need a migration of stored data.
    exercises: problemMap(ProblemProgressSchema),
  })
  .refine(({ exercises }) => {
    const ids = Object.values(exercises).flatMap(({ attempts }) => attempts.map(({ id }) => id));
    return new Set(ids).size === ids.length;
  }, 'Submission IDs must be unique.');
export const ProgressStateSchema = z.object({
  revision: count,
  progress: ProgressSchema,
  stars: z
    .array(Identifier)
    .max(MAX_PROBLEMS)
    .transform((ids) => [...new Set(ids)].sort()),
});

const DraftChangeSchema = z.strictObject({ at: Timestamp, value: CodeText });
/**
 * Unsaved edits: the latest draft and star per problem. Not strict, because an older tab may
 * still send `solved`; parsing drops it.
 */
export const ProgressChangesSchema = z.object({
  drafts: problemMap(DraftChangeSchema),
  stars: problemMap(z.boolean()),
});

export type Attempt = z.infer<typeof AttemptSchema>;
export type ProgressData = z.infer<typeof ProgressSchema>;
export type ProgressState = z.infer<typeof ProgressStateSchema>;
export type ProgressChanges = z.infer<typeof ProgressChangesSchema>;

export const noChanges = (): ProgressChanges => ({ drafts: {}, stars: {} });

/**
 * The newest draft wins, so a late save can't replace newer code; stars take the value sent.
 * Solved flags come only from the judge.
 */
export function applyProgressChanges(state: ProgressState, changes: ProgressChanges) {
  const exercises = { ...state.progress.exercises };
  for (const [id, draft] of Object.entries(changes.drafts)) {
    const previous = exercises[id];
    if (!previous || Date.parse(draft.at) > Date.parse(previous.updatedAt))
      exercises[id] = {
        ...(previous ?? { solved: false, attempts: [] }),
        draft: draft.value,
        updatedAt: draft.at,
      };
  }
  const stars = new Set(state.stars);
  for (const [id, starred] of Object.entries(changes.stars)) {
    if (starred) stars.add(id);
    else stars.delete(id);
  }
  return { progress: { version: 1 as const, exercises }, stars: [...stars].sort() };
}
