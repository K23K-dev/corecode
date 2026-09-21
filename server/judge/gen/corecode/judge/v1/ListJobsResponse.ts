// Original file: runner/proto/judge.proto

import type {
  JobSnapshot as _corecode_judge_v1_JobSnapshot,
  JobSnapshot__Output as _corecode_judge_v1_JobSnapshot__Output,
} from '../../../corecode/judge/v1/JobSnapshot.js';

export interface ListJobsResponse {
  jobs?: _corecode_judge_v1_JobSnapshot[];
  nextPageToken?: string;
}

export interface ListJobsResponse__Output {
  jobs: _corecode_judge_v1_JobSnapshot__Output[];
  nextPageToken: string;
}
