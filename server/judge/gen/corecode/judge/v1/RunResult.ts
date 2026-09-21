// Original file: runner/proto/judge.proto

import type {
  CaseResult as _corecode_judge_v1_CaseResult,
  CaseResult__Output as _corecode_judge_v1_CaseResult__Output,
} from '../../../corecode/judge/v1/CaseResult.js';

/**
 * Mirrors the existing UI result, independently of durable job metadata.
 */
export interface RunResult {
  cases?: _corecode_judge_v1_CaseResult[];
  stdout?: string;
  durationMs?: number | string;
  error?: string;
  _error?: 'error';
}

/**
 * Mirrors the existing UI result, independently of durable job metadata.
 */
export interface RunResult__Output {
  cases: _corecode_judge_v1_CaseResult__Output[];
  stdout: string;
  durationMs: number;
  error?: string;
}
