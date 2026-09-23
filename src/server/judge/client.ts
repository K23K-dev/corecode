import 'server-only';
import { Agent } from 'node:https';
import { createClient, type Interceptor } from '@connectrpc/connect';
import {
  createGrpcTransport,
  createGrpcWebTransport,
  Http2SessionManager,
} from '@connectrpc/connect-node';
import { readJudgeConfiguration } from './config.ts';
import { JudgeService } from './gen/judge_pb.ts';
import { Health, HealthCheckResponse_ServingStatus } from './gen/grpc/health/v1/health_pb.ts';

export type JudgeClient = ReturnType<typeof createJudgeClient>;

/** Native gRPC locally; gRPC-Web crosses Sandbox's HTTPS proxy. */
export function createJudgeClient(
  address = process.env.JUDGE_ADDRESS,
  {
    token = process.env.JUDGE_TOKEN,
    hosted = process.env.VERCEL === '1',
    protocol = 'grpc',
  }: { token?: string; hosted?: boolean; protocol?: 'grpc' | 'grpc-web' } = {},
) {
  let baseUrl: string;
  if (protocol === 'grpc-web') {
    const url = new URL(address ?? '');
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('The Sandbox judge must use an HTTPS origin.');
    readJudgeConfiguration({ address: `${url.hostname}:${url.port || 443}`, token, hosted: true });
    baseUrl = url.origin;
  } else {
    const config = readJudgeConfiguration({ address, token, hosted });
    baseUrl = `${config.tls ? 'https' : 'http'}://${config.address}`;
  }
  const authorize: Interceptor = (next) => (request) => {
    request.header.set('authorization', `Bearer ${token}`);
    return next(request);
  };
  const options = {
    baseUrl,
    readMaxBytes: 1024 * 1024,
    writeMaxBytes: 1024 * 1024,
    interceptors: [authorize],
  };
  const session =
    protocol === 'grpc'
      ? new Http2SessionManager(baseUrl, { idleConnectionTimeoutMs: 60_000 })
      : undefined;
  const agent = protocol === 'grpc-web' ? new Agent({ keepAlive: true }) : undefined;
  const transport =
    protocol === 'grpc-web'
      ? createGrpcWebTransport({ ...options, httpVersion: '1.1', nodeOptions: { agent } })
      : createGrpcTransport({ ...options, sessionManager: session });
  const health = createClient(Health, transport);
  return {
    service: createClient(JudgeService, transport),
    async checkHealth(service = '') {
      const response = await health.check({ service }, { timeoutMs: 2000 });
      return HealthCheckResponse_ServingStatus[response.status];
    },
    close() {
      session?.abort();
      agent?.destroy();
    },
  };
}
