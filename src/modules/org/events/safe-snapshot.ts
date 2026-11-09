import type { EntityManager } from 'typeorm';
import type { Safe } from '@/modules/safe/domain/entities/safe.entity';

export type Snapshot = {
  owners: Array<string>;
  threshold: number;
  modules: Array<string>;
  guard: string | null;
  version: string | null;
};

const ZERO = '0x0000000000000000000000000000000000000000';

export function toSnapshot(safe: Safe): Snapshot {
  return {
    owners: safe.owners,
    threshold: safe.threshold,
    modules: safe.modules ?? [],
    guard: safe.guard === ZERO ? null : safe.guard,
    version: safe.version ?? null,
  };
}

const COLUMNS = `(chain_id, address, owners, threshold, modules, guard, version, updated_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, now())`;

const args = (
  chainId: string,
  address: string,
  s: Snapshot,
): Array<unknown> => [
  chainId,
  address,
  s.owners,
  s.threshold,
  s.modules,
  s.guard,
  s.version,
];

/** Seeds never overwrite: a seed older than a diff-written row must lose. */
export async function seedSnapshotIfAbsent(
  em: EntityManager,
  chainId: string,
  address: string,
  s: Snapshot,
): Promise<void> {
  await em.query(
    `INSERT INTO linked_safe_snapshots ${COLUMNS}
     ON CONFLICT (chain_id, address) DO NOTHING`,
    args(chainId, address, s),
  );
}

export async function overwriteSnapshot(
  em: EntityManager,
  chainId: string,
  address: string,
  s: Snapshot,
): Promise<void> {
  await em.query(
    `INSERT INTO linked_safe_snapshots ${COLUMNS}
     ON CONFLICT (chain_id, address) DO UPDATE SET
       owners = EXCLUDED.owners, threshold = EXCLUDED.threshold,
       modules = EXCLUDED.modules, guard = EXCLUDED.guard,
       version = EXCLUDED.version, updated_at = now()`,
    args(chainId, address, s),
  );
}
