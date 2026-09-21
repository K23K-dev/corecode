// Original file: runner/proto/judge.proto

import type * as grpc from '@grpc/grpc-js';
import type { MethodDefinition } from '@grpc/proto-loader';
import type {
  JobRequest as _corecode_judge_v1_JobRequest,
  JobRequest__Output as _corecode_judge_v1_JobRequest__Output,
} from '../../../corecode/judge/v1/JobRequest.js';
import type {
  JobSnapshot as _corecode_judge_v1_JobSnapshot,
  JobSnapshot__Output as _corecode_judge_v1_JobSnapshot__Output,
} from '../../../corecode/judge/v1/JobSnapshot.js';
import type {
  ListJobsRequest as _corecode_judge_v1_ListJobsRequest,
  ListJobsRequest__Output as _corecode_judge_v1_ListJobsRequest__Output,
} from '../../../corecode/judge/v1/ListJobsRequest.js';
import type {
  ListJobsResponse as _corecode_judge_v1_ListJobsResponse,
  ListJobsResponse__Output as _corecode_judge_v1_ListJobsResponse__Output,
} from '../../../corecode/judge/v1/ListJobsResponse.js';
import type {
  RunRequest as _corecode_judge_v1_RunRequest,
  RunRequest__Output as _corecode_judge_v1_RunRequest__Output,
} from '../../../corecode/judge/v1/RunRequest.js';
import type {
  RunResult as _corecode_judge_v1_RunResult,
  RunResult__Output as _corecode_judge_v1_RunResult__Output,
} from '../../../corecode/judge/v1/RunResult.js';
import type {
  SubmitRequest as _corecode_judge_v1_SubmitRequest,
  SubmitRequest__Output as _corecode_judge_v1_SubmitRequest__Output,
} from '../../../corecode/judge/v1/SubmitRequest.js';

/**
 * Internal server-to-server API. The judge loads the exact private grading spec
 * from the database; callers cannot select a runtime or supply grading cases.
 */
export interface JudgeServiceClient extends grpc.Client {
  /**
   * Queued work can cancel immediately; running work remains CANCELING until
   * cleanup is confirmed. Already terminal jobs return their existing outcome.
   */
  CancelJob(
    argument: _corecode_judge_v1_JobRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  CancelJob(
    argument: _corecode_judge_v1_JobRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  CancelJob(
    argument: _corecode_judge_v1_JobRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  CancelJob(
    argument: _corecode_judge_v1_JobRequest,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  /**
   * Queued work can cancel immediately; running work remains CANCELING until
   * cleanup is confirmed. Already terminal jobs return their existing outcome.
   */
  cancelJob(
    argument: _corecode_judge_v1_JobRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  cancelJob(
    argument: _corecode_judge_v1_JobRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  cancelJob(
    argument: _corecode_judge_v1_JobRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  cancelJob(
    argument: _corecode_judge_v1_JobRequest,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;

  GetJob(
    argument: _corecode_judge_v1_JobRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  GetJob(
    argument: _corecode_judge_v1_JobRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  GetJob(
    argument: _corecode_judge_v1_JobRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  GetJob(
    argument: _corecode_judge_v1_JobRequest,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  getJob(
    argument: _corecode_judge_v1_JobRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  getJob(
    argument: _corecode_judge_v1_JobRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  getJob(
    argument: _corecode_judge_v1_JobRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  getJob(
    argument: _corecode_judge_v1_JobRequest,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;

  /**
   * Returns status metadata without grading results; use GetJob for the result.
   */
  ListJobs(
    argument: _corecode_judge_v1_ListJobsRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_corecode_judge_v1_ListJobsResponse__Output>,
  ): grpc.ClientUnaryCall;
  ListJobs(
    argument: _corecode_judge_v1_ListJobsRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_corecode_judge_v1_ListJobsResponse__Output>,
  ): grpc.ClientUnaryCall;
  ListJobs(
    argument: _corecode_judge_v1_ListJobsRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_corecode_judge_v1_ListJobsResponse__Output>,
  ): grpc.ClientUnaryCall;
  ListJobs(
    argument: _corecode_judge_v1_ListJobsRequest,
    callback: grpc.requestCallback<_corecode_judge_v1_ListJobsResponse__Output>,
  ): grpc.ClientUnaryCall;
  /**
   * Returns status metadata without grading results; use GetJob for the result.
   */
  listJobs(
    argument: _corecode_judge_v1_ListJobsRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_corecode_judge_v1_ListJobsResponse__Output>,
  ): grpc.ClientUnaryCall;
  listJobs(
    argument: _corecode_judge_v1_ListJobsRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_corecode_judge_v1_ListJobsResponse__Output>,
  ): grpc.ClientUnaryCall;
  listJobs(
    argument: _corecode_judge_v1_ListJobsRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_corecode_judge_v1_ListJobsResponse__Output>,
  ): grpc.ClientUnaryCall;
  listJobs(
    argument: _corecode_judge_v1_ListJobsRequest,
    callback: grpc.requestCallback<_corecode_judge_v1_ListJobsResponse__Output>,
  ): grpc.ClientUnaryCall;

  /**
   * Ephemeral example execution. Disconnecting or canceling the RPC stops it.
   */
  Run(
    argument: _corecode_judge_v1_RunRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_corecode_judge_v1_RunResult__Output>,
  ): grpc.ClientUnaryCall;
  Run(
    argument: _corecode_judge_v1_RunRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_corecode_judge_v1_RunResult__Output>,
  ): grpc.ClientUnaryCall;
  Run(
    argument: _corecode_judge_v1_RunRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_corecode_judge_v1_RunResult__Output>,
  ): grpc.ClientUnaryCall;
  Run(
    argument: _corecode_judge_v1_RunRequest,
    callback: grpc.requestCallback<_corecode_judge_v1_RunResult__Output>,
  ): grpc.ClientUnaryCall;
  /**
   * Ephemeral example execution. Disconnecting or canceling the RPC stops it.
   */
  run(
    argument: _corecode_judge_v1_RunRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_corecode_judge_v1_RunResult__Output>,
  ): grpc.ClientUnaryCall;
  run(
    argument: _corecode_judge_v1_RunRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_corecode_judge_v1_RunResult__Output>,
  ): grpc.ClientUnaryCall;
  run(
    argument: _corecode_judge_v1_RunRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_corecode_judge_v1_RunResult__Output>,
  ): grpc.ClientUnaryCall;
  run(
    argument: _corecode_judge_v1_RunRequest,
    callback: grpc.requestCallback<_corecode_judge_v1_RunResult__Output>,
  ): grpc.ClientUnaryCall;

  /**
   * Acknowledges a durable submission. Disconnecting does not cancel the job.
   */
  Submit(
    argument: _corecode_judge_v1_SubmitRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  Submit(
    argument: _corecode_judge_v1_SubmitRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  Submit(
    argument: _corecode_judge_v1_SubmitRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  Submit(
    argument: _corecode_judge_v1_SubmitRequest,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  /**
   * Acknowledges a durable submission. Disconnecting does not cancel the job.
   */
  submit(
    argument: _corecode_judge_v1_SubmitRequest,
    metadata: grpc.Metadata,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  submit(
    argument: _corecode_judge_v1_SubmitRequest,
    metadata: grpc.Metadata,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  submit(
    argument: _corecode_judge_v1_SubmitRequest,
    options: grpc.CallOptions,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;
  submit(
    argument: _corecode_judge_v1_SubmitRequest,
    callback: grpc.requestCallback<_corecode_judge_v1_JobSnapshot__Output>,
  ): grpc.ClientUnaryCall;

  /**
   * Sends the current snapshot, then changes. Disconnecting only stops watching.
   */
  WatchJob(
    argument: _corecode_judge_v1_JobRequest,
    metadata: grpc.Metadata,
    options?: grpc.CallOptions,
  ): grpc.ClientReadableStream<_corecode_judge_v1_JobSnapshot__Output>;
  WatchJob(
    argument: _corecode_judge_v1_JobRequest,
    options?: grpc.CallOptions,
  ): grpc.ClientReadableStream<_corecode_judge_v1_JobSnapshot__Output>;
  /**
   * Sends the current snapshot, then changes. Disconnecting only stops watching.
   */
  watchJob(
    argument: _corecode_judge_v1_JobRequest,
    metadata: grpc.Metadata,
    options?: grpc.CallOptions,
  ): grpc.ClientReadableStream<_corecode_judge_v1_JobSnapshot__Output>;
  watchJob(
    argument: _corecode_judge_v1_JobRequest,
    options?: grpc.CallOptions,
  ): grpc.ClientReadableStream<_corecode_judge_v1_JobSnapshot__Output>;
}

/**
 * Internal server-to-server API. The judge loads the exact private grading spec
 * from the database; callers cannot select a runtime or supply grading cases.
 */
export interface JudgeServiceHandlers extends grpc.UntypedServiceImplementation {
  /**
   * Queued work can cancel immediately; running work remains CANCELING until
   * cleanup is confirmed. Already terminal jobs return their existing outcome.
   */
  CancelJob: grpc.handleUnaryCall<
    _corecode_judge_v1_JobRequest__Output,
    _corecode_judge_v1_JobSnapshot
  >;

  GetJob: grpc.handleUnaryCall<
    _corecode_judge_v1_JobRequest__Output,
    _corecode_judge_v1_JobSnapshot
  >;

  /**
   * Returns status metadata without grading results; use GetJob for the result.
   */
  ListJobs: grpc.handleUnaryCall<
    _corecode_judge_v1_ListJobsRequest__Output,
    _corecode_judge_v1_ListJobsResponse
  >;

  /**
   * Ephemeral example execution. Disconnecting or canceling the RPC stops it.
   */
  Run: grpc.handleUnaryCall<_corecode_judge_v1_RunRequest__Output, _corecode_judge_v1_RunResult>;

  /**
   * Acknowledges a durable submission. Disconnecting does not cancel the job.
   */
  Submit: grpc.handleUnaryCall<
    _corecode_judge_v1_SubmitRequest__Output,
    _corecode_judge_v1_JobSnapshot
  >;

  /**
   * Sends the current snapshot, then changes. Disconnecting only stops watching.
   */
  WatchJob: grpc.handleServerStreamingCall<
    _corecode_judge_v1_JobRequest__Output,
    _corecode_judge_v1_JobSnapshot
  >;
}

export interface JudgeServiceDefinition extends grpc.ServiceDefinition {
  CancelJob: MethodDefinition<
    _corecode_judge_v1_JobRequest,
    _corecode_judge_v1_JobSnapshot,
    _corecode_judge_v1_JobRequest__Output,
    _corecode_judge_v1_JobSnapshot__Output
  >;
  GetJob: MethodDefinition<
    _corecode_judge_v1_JobRequest,
    _corecode_judge_v1_JobSnapshot,
    _corecode_judge_v1_JobRequest__Output,
    _corecode_judge_v1_JobSnapshot__Output
  >;
  ListJobs: MethodDefinition<
    _corecode_judge_v1_ListJobsRequest,
    _corecode_judge_v1_ListJobsResponse,
    _corecode_judge_v1_ListJobsRequest__Output,
    _corecode_judge_v1_ListJobsResponse__Output
  >;
  Run: MethodDefinition<
    _corecode_judge_v1_RunRequest,
    _corecode_judge_v1_RunResult,
    _corecode_judge_v1_RunRequest__Output,
    _corecode_judge_v1_RunResult__Output
  >;
  Submit: MethodDefinition<
    _corecode_judge_v1_SubmitRequest,
    _corecode_judge_v1_JobSnapshot,
    _corecode_judge_v1_SubmitRequest__Output,
    _corecode_judge_v1_JobSnapshot__Output
  >;
  WatchJob: MethodDefinition<
    _corecode_judge_v1_JobRequest,
    _corecode_judge_v1_JobSnapshot,
    _corecode_judge_v1_JobRequest__Output,
    _corecode_judge_v1_JobSnapshot__Output
  >;
}
