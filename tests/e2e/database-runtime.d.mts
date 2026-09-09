import type { Client, PoolClient } from 'pg';

export const projectRoot: string;
export const runtimeDirectory: string;
export class TestDatabaseSafetyError extends Error {}
export function loadTestEnvironment(): void;
export function getTestDatabaseConnection(): { connectionString: string };
export function createIsolatedTestDatabase(): Promise<{
  connectionString: string;
  cleanup(): Promise<void>;
}>;
export function runtimePath(): string;
export function testSchema(connectionString: string): string;
export function readRuntime(): Promise<{
  runId: string;
  schema: string;
  connectionString: string;
  serverPid: number;
}>;
export function assertTestConnection(
  client: Client | PoolClient,
  connectionString: string,
  allowMissingSchema?: boolean,
): Promise<string>;
export function cleanupRuntime(): Promise<void>;
