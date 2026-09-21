// Original file: runner/proto/judge.proto

export interface SubmitRequest {
  /**
   * UUID supplied once by the caller and reused for retries of the same payload.
   * Reusing it with different immutable input returns ALREADY_EXISTS.
   */
  submissionId?: string;
  problemId?: string;
  problemVersion?: string;
  code?: string;
  /**
   * Pending solved-state intent and superseded IDs captured when submitting.
   * Only an accepted result retires these IDs; later user intentions survive.
   */
  completionIntentIds?: string[];
}

export interface SubmitRequest__Output {
  /**
   * UUID supplied once by the caller and reused for retries of the same payload.
   * Reusing it with different immutable input returns ALREADY_EXISTS.
   */
  submissionId: string;
  problemId: string;
  problemVersion: string;
  code: string;
  /**
   * Pending solved-state intent and superseded IDs captured when submitting.
   * Only an accepted result retires these IDs; later user intentions survive.
   */
  completionIntentIds: string[];
}
