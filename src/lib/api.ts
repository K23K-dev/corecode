/** An error response from the practice API, with its HTTP status and error code. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

/**
 * Same-origin JSON request. Requests with a body send the header the API requires
 * for writes. `failure` replaces the API's message for an unsuccessful response.
 */
export async function requestJson(
  path: string,
  {
    method,
    body,
    signal,
    timeoutMs = 8000,
    failure,
  }: {
    method?: 'GET' | 'POST' | 'PUT';
    body?: unknown;
    signal?: AbortSignal;
    timeoutMs?: number;
    failure?: string;
  } = {},
): Promise<{ status: number; value: unknown }> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await fetch(path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    ...(body !== undefined && {
      headers: { 'Content-Type': 'application/json', 'X-Code-Practice-Client': '1' },
      body: JSON.stringify(body),
    }),
  });
  if (response.status === 401 || response.status === 403)
    throw new ApiError(
      'Sign in with an account that can access this app, then reload.',
      response.status,
    );
  // Not an API response (for example, a proxy error page): no status to act on.
  if (!response.headers.get('content-type')?.includes('application/json'))
    throw new Error('The practice API is unavailable. Please retry.');
  const value: unknown = JSON.parse(await response.text());
  if (!response.ok) {
    const { error, code } = (value ?? {}) as { error?: unknown; code?: unknown };
    throw new ApiError(
      failure ?? (typeof error === 'string' ? error : 'The practice API request failed.'),
      response.status,
      typeof code === 'string' ? code : undefined,
    );
  }
  return { status: response.status, value };
}
