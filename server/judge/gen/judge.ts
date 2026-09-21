import type * as grpc from '@grpc/grpc-js';
import type { EnumTypeDefinition, MessageTypeDefinition } from '@grpc/proto-loader';

import type {
  CaseResult as _corecode_judge_v1_CaseResult,
  CaseResult__Output as _corecode_judge_v1_CaseResult__Output,
} from './corecode/judge/v1/CaseResult.js';
import type {
  JobRequest as _corecode_judge_v1_JobRequest,
  JobRequest__Output as _corecode_judge_v1_JobRequest__Output,
} from './corecode/judge/v1/JobRequest.js';
import type {
  JobSnapshot as _corecode_judge_v1_JobSnapshot,
  JobSnapshot__Output as _corecode_judge_v1_JobSnapshot__Output,
} from './corecode/judge/v1/JobSnapshot.js';
import type {
  JudgeServiceClient as _corecode_judge_v1_JudgeServiceClient,
  JudgeServiceDefinition as _corecode_judge_v1_JudgeServiceDefinition,
} from './corecode/judge/v1/JudgeService.js';
import type {
  ListJobsRequest as _corecode_judge_v1_ListJobsRequest,
  ListJobsRequest__Output as _corecode_judge_v1_ListJobsRequest__Output,
} from './corecode/judge/v1/ListJobsRequest.js';
import type {
  ListJobsResponse as _corecode_judge_v1_ListJobsResponse,
  ListJobsResponse__Output as _corecode_judge_v1_ListJobsResponse__Output,
} from './corecode/judge/v1/ListJobsResponse.js';
import type {
  RunRequest as _corecode_judge_v1_RunRequest,
  RunRequest__Output as _corecode_judge_v1_RunRequest__Output,
} from './corecode/judge/v1/RunRequest.js';
import type {
  RunResult as _corecode_judge_v1_RunResult,
  RunResult__Output as _corecode_judge_v1_RunResult__Output,
} from './corecode/judge/v1/RunResult.js';
import type {
  SubmitRequest as _corecode_judge_v1_SubmitRequest,
  SubmitRequest__Output as _corecode_judge_v1_SubmitRequest__Output,
} from './corecode/judge/v1/SubmitRequest.js';

type SubtypeConstructor<Constructor extends new (...args: any) => any, Subtype> = {
  new (...args: ConstructorParameters<Constructor>): Subtype;
};

export interface ProtoGrpcType {
  corecode: {
    judge: {
      v1: {
        CaseResult: MessageTypeDefinition<
          _corecode_judge_v1_CaseResult,
          _corecode_judge_v1_CaseResult__Output
        >;
        JobRequest: MessageTypeDefinition<
          _corecode_judge_v1_JobRequest,
          _corecode_judge_v1_JobRequest__Output
        >;
        JobSnapshot: MessageTypeDefinition<
          _corecode_judge_v1_JobSnapshot,
          _corecode_judge_v1_JobSnapshot__Output
        >;
        JobState: EnumTypeDefinition;
        /**
         * Internal server-to-server API. The judge loads the exact private grading spec
         * from the database; callers cannot select a runtime or supply grading cases.
         */
        JudgeService: SubtypeConstructor<
          typeof grpc.Client,
          _corecode_judge_v1_JudgeServiceClient
        > & { service: _corecode_judge_v1_JudgeServiceDefinition };
        ListJobsRequest: MessageTypeDefinition<
          _corecode_judge_v1_ListJobsRequest,
          _corecode_judge_v1_ListJobsRequest__Output
        >;
        ListJobsResponse: MessageTypeDefinition<
          _corecode_judge_v1_ListJobsResponse,
          _corecode_judge_v1_ListJobsResponse__Output
        >;
        RunRequest: MessageTypeDefinition<
          _corecode_judge_v1_RunRequest,
          _corecode_judge_v1_RunRequest__Output
        >;
        RunResult: MessageTypeDefinition<
          _corecode_judge_v1_RunResult,
          _corecode_judge_v1_RunResult__Output
        >;
        SubmitRequest: MessageTypeDefinition<
          _corecode_judge_v1_SubmitRequest,
          _corecode_judge_v1_SubmitRequest__Output
        >;
      };
    };
  };
}
