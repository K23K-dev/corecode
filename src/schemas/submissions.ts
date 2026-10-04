import { z } from 'zod';
import { CodeText, Identifier, ProblemVersion } from './progress';

export const JobID = z
  .string()
  .regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i)
  .toLowerCase();
const input = { problemId: Identifier, problemVersion: ProblemVersion, code: CodeText.max(32768) };
export const ExecutionRequest = z.discriminatedUnion('mode', [
  z.strictObject({ ...input, mode: z.literal('example') }),
  z.strictObject({ ...input, mode: z.literal('submit'), submissionId: JobID }),
]);
const CaseResultSchema = z.object({
  name: z.string(),
  input: z.string(),
  expected: z.string().optional(),
  actual: z.string().optional(),
  passed: z.boolean().optional(),
  error: z.string().optional(),
});
export const RunResultSchema = z.object({
  cases: z.array(CaseResultSchema).max(32),
  stdout: z.string(),
  durationMs: z.number().nonnegative(),
  error: z.string().optional(),
});
export const JobSnapshotSchema = z.object({
  jobId: JobID,
  problemId: Identifier,
  state: z.enum(['queued', 'running', 'canceling', 'completed', 'failed', 'canceled']),
  result: RunResultSchema.optional(),
  error: z.string().optional(),
  revision: z.string().regex(/^\d+$/),
});
export type RunResult = z.infer<typeof RunResultSchema>;
export type JobSnapshot = z.infer<typeof JobSnapshotSchema>;
