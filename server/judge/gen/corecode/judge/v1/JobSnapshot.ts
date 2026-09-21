// Original file: runner/proto/judge.proto

import type {
  JobState as _corecode_judge_v1_JobState,
  JobState__Output as _corecode_judge_v1_JobState__Output,
} from '../../../corecode/judge/v1/JobState.js';
import type {
  RunResult as _corecode_judge_v1_RunResult,
  RunResult__Output as _corecode_judge_v1_RunResult__Output,
} from '../../../corecode/judge/v1/RunResult.js';
import type { Long } from '@grpc/proto-loader';

export interface JobSnapshot {
  jobId?: string;
  problemId?: string;
  problemVersion?: string;
  state?: _corecode_judge_v1_JobState;
  /**
   * Server timestamps in UTC RFC 3339 format; absent before the transition.
   */
  createdAt?: string;
  startedAt?: string;
  finishedAt?: string;
  result?: _corecode_judge_v1_RunResult | null;
  error?: string;
  /**
   * Monotonically increases with each transition so watchers can ignore old snapshots.
   */
  revision?: number | string | Long;
  _startedAt?: 'startedAt';
  _finishedAt?: 'finishedAt';
  _error?: 'error';
}

export interface JobSnapshot__Output {
  jobId: string;
  problemId: string;
  problemVersion: string;
  state: _corecode_judge_v1_JobState__Output;
  /**
   * Server timestamps in UTC RFC 3339 format; absent before the transition.
   */
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  result: _corecode_judge_v1_RunResult__Output | null;
  error?: string;
  /**
   * Monotonically increases with each transition so watchers can ignore old snapshots.
   */
  revision: string;
}
