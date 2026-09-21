// Original file: runner/proto/judge.proto

export interface RunRequest {
  problemId?: string;
  problemVersion?: string;
  code?: string;
}

export interface RunRequest__Output {
  problemId: string;
  problemVersion: string;
  code: string;
}
