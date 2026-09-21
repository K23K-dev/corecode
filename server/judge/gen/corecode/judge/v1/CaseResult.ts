// Original file: runner/proto/judge.proto

export interface CaseResult {
  name?: string;
  input?: string;
  expected?: string;
  actual?: string;
  passed?: boolean;
  error?: string;
  _expected?: 'expected';
  _actual?: 'actual';
  _passed?: 'passed';
  _error?: 'error';
}

export interface CaseResult__Output {
  name: string;
  input: string;
  expected?: string;
  actual?: string;
  passed?: boolean;
  error?: string;
}
