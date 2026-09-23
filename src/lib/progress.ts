import {
  fitsBytes,
  MAX_BACKUP_BYTES,
  validateProgress,
  type ProgressData,
} from '../shared/progress.ts';

export type { Attempt, ExerciseProgress, ProgressData } from '../shared/progress.ts';
export {
  MAX_ATTEMPTS_PER_EXERCISE,
  MAX_CODE_BYTES,
  MAX_BACKUP_BYTES,
  MAX_EXERCISES,
} from '../shared/progress.ts';

/** Minimal storage interface for browser migration and recovery. */
export interface ProgressStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const PROGRESS_STORAGE_KEY = 'coding-practice:progress:v1';

/** Validate and clone a backup. No storage is touched, even when parsing fails. */
export function parseProgressBackup(
  text: string,
  options: { retainAttempts?: boolean } = {},
): ProgressData {
  if (typeof text !== 'string') throw new Error('Progress backup must be JSON text.');
  if (!fitsBytes(text, MAX_BACKUP_BYTES))
    throw new Error('Progress backup exceeds the 10 MB size limit.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Progress backup is not valid JSON.');
  }
  return validateProgress(parsed, { ...options, label: 'Progress backup' });
}

/** Export a validated copy, preserving the complete draft and latest 20 attempts. */
export function exportProgress(data: ProgressData): string {
  const serialized = JSON.stringify(validateProgress(data), null, 2);
  if (!fitsBytes(serialized, MAX_BACKUP_BYTES))
    throw new Error('Progress backup exceeds the 10 MB size limit.');
  return serialized;
}
