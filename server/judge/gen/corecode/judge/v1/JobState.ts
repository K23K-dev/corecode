// Original file: runner/proto/judge.proto

export const JobState = {
  JOB_STATE_UNSPECIFIED: 'JOB_STATE_UNSPECIFIED',
  JOB_STATE_QUEUED: 'JOB_STATE_QUEUED',
  JOB_STATE_RUNNING: 'JOB_STATE_RUNNING',
  JOB_STATE_CANCELING: 'JOB_STATE_CANCELING',
  /**
   * Grading finished, including learner failures represented in RunResult.
   */
  JOB_STATE_COMPLETED: 'JOB_STATE_COMPLETED',
  /**
   * Infrastructure or grading-spec failure, not a learner's failed case.
   */
  JOB_STATE_FAILED: 'JOB_STATE_FAILED',
  JOB_STATE_CANCELED: 'JOB_STATE_CANCELED',
} as const;

export type JobState =
  | 'JOB_STATE_UNSPECIFIED'
  | 0
  | 'JOB_STATE_QUEUED'
  | 1
  | 'JOB_STATE_RUNNING'
  | 2
  | 'JOB_STATE_CANCELING'
  | 3
  /**
   * Grading finished, including learner failures represented in RunResult.
   */
  | 'JOB_STATE_COMPLETED'
  | 4
  /**
   * Infrastructure or grading-spec failure, not a learner's failed case.
   */
  | 'JOB_STATE_FAILED'
  | 5
  | 'JOB_STATE_CANCELED'
  | 6;

export type JobState__Output = (typeof JobState)[keyof typeof JobState];
