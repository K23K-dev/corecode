/** Validate server-only judge settings without opening a connection. */
export function readExecutionConfiguration(
  environment: Record<string, string | undefined>,
  hosted: boolean,
) {
  const name = environment.JUDGE_SANDBOX_NAME?.trim();
  if (name) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name))
      throw new Error('JUDGE_SANDBOX_NAME must be a lowercase sandbox name.');
    if (environment.JUDGE_ADDRESS)
      throw new Error('Set JUDGE_SANDBOX_NAME or JUDGE_ADDRESS, not both.');
    const { token } = readJudgeConfiguration({ token: environment.JUDGE_TOKEN });
    return { name, token };
  }
  return readJudgeConfiguration({
    address: environment.JUDGE_ADDRESS,
    token: environment.JUDGE_TOKEN,
    hosted,
  });
}

export function readJudgeConfiguration({
  address,
  token,
  hosted = false,
}: {
  address?: string;
  token?: string;
  hosted?: boolean;
} = {}) {
  if (hosted && !address) throw new Error('Configure JUDGE_SANDBOX_NAME for the hosted judge.');
  address = address?.trim() || '127.0.0.1:50051';
  const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(address);
  const host = match?.[1].toLowerCase();
  const loopback = host !== undefined && ['127.0.0.1', 'localhost', '[::1]'].includes(host);
  const remote =
    host &&
    host.length <= 253 &&
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) &&
    !/(?:^|\.)(?:localhost|local)$/.test(host);
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535 || (!loopback && !remote))
    throw new Error('JUDGE_ADDRESS must be a loopback or public DNS host and port.');
  if (hosted && loopback) throw new Error('The hosted judge must use a remote TLS endpoint.');
  if (typeof token !== 'string' || !/^[\x21-\x7e]{32,256}$/.test(token))
    throw new Error('JUDGE_TOKEN must contain 32–256 non-whitespace ASCII characters.');
  return { address: `${host}:${Number(match[2])}`, token, tls: !loopback };
}
