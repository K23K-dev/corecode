// Original file: runner/proto/judge.proto

export interface ListJobsRequest {
  problemId?: string;
  pageSize?: number;
  pageToken?: string;
}

export interface ListJobsRequest__Output {
  problemId: string;
  pageSize: number;
  pageToken: string;
}
