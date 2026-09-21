export function readJudgeConfiguration(options?: {
  address?: string;
  token?: string;
  hosted?: boolean;
}): { address: string; token: string; tls: boolean };

export function readExecutionConfiguration(
  environment: Record<string, string | undefined>,
  hosted: boolean,
): { name: string; token: string } | { address: string; token: string; tls: boolean };
