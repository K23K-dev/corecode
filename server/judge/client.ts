import 'server-only';
import { fileURLToPath } from 'node:url';
import { credentials, loadPackageDefinition } from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import type { ProtoGrpcType as JudgeProto } from './gen/judge.js';
import type { ProtoGrpcType as HealthProto } from './gen/health.js';
import type { HealthCheckResponse__Output } from './gen/grpc/health/v1/HealthCheckResponse.js';

const protoDirectory = fileURLToPath(new URL('../../runner/proto/', import.meta.url));
const definitions = loadSync(['judge.proto', 'grpc/health/v1/health.proto'], {
  includeDirs: [protoDirectory],
  longs: String,
  enums: String,
  defaults: true,
});
const protocol = loadPackageDefinition(definitions) as unknown as JudgeProto & HealthProto;

/** Internal transport only; the website keeps its current runner until cutover. */
export function createJudgeClient(address = process.env.JUDGE_ADDRESS ?? '127.0.0.1:50051') {
  const match = /^(?:127\.0\.0\.1|localhost|\[::1\]):([0-9]+)$/.exec(address);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65535) {
    throw new Error('JUDGE_ADDRESS must be a loopback host and port.');
  }

  const options = {
    'grpc.max_send_message_length': 1024 * 1024,
    'grpc.max_receive_message_length': 1024 * 1024,
  };
  const service = new protocol.corecode.judge.v1.JudgeService(
    address,
    credentials.createInsecure(),
    options,
  );
  const health = new protocol.grpc.health.v1.Health(address, credentials.createInsecure(), options);

  return {
    service,
    checkHealth(serviceName = '') {
      return new Promise<HealthCheckResponse__Output['status']>((resolve, reject) => {
        health.check({ service: serviceName }, { deadline: Date.now() + 2000 }, (error, reply) => {
          if (error) reject(error);
          else if (!reply) reject(new Error('The judge returned no health status.'));
          else resolve(reply.status);
        });
      });
    },
    close() {
      service.close();
      health.close();
    },
  };
}
