export type GradingSnapshotRow = {
  problem: Record<string, unknown> & { id: string; version: string; runtime: string };
  spec: Record<string, unknown> & { runtime: string; cases: unknown[] };
  specVersion: string;
};

export function readGradingSnapshot(): Promise<GradingSnapshotRow[]>;
export function readCatalogSnapshot(): Promise<Catalog>;
export function copyCatalogToTestDatabase(connectionString: string): Promise<number>;
import type { Catalog } from '../src/lib/database-client';
