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

/**
 * One Safe at a time across events, reconcile runs and links; held to
 * commit. Bounded wait: lock_timeout.
 */
export async function lockSafe(
  em: EntityManager,
  chainId: string,
  address: string,
): Promise<void> {
  await em.query(`SET LOCAL lock_timeout = '10s'`);
  await em.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
    `${chainId}:${address.toLowerCase()}`,
  ]);
}

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

/**
 * Item 8: drops the snapshots of these Safes that no org links any more, so
 * a later link starts from the current state, not from before the gap.
 * Without the per-Safe lock (callers hold org locks; a concurrent diff that
 * rewrites the row is corrected by the overwrite on the next link).
 */
export async function deleteUnlinkedSnapshots(
  em: Pick<EntityManager, 'query'>,
  safes: Array<{ chainId: string; address: string }>,
): Promise<void> {
  if (safes.length === 0) return;
  await em.query(
    `DELETE FROM linked_safe_snapshots s
     USING unnest($1::text[], $2::text[]) AS t(chain_id, address)
     WHERE s.chain_id = t.chain_id AND s.address = t.address::citext
       AND NOT EXISTS (SELECT 1 FROM linked_safes l
                       WHERE l.chain_id = s.chain_id AND l.address = s.address)`,
    [safes.map((x) => x.chainId), safes.map((x) => x.address)],
  );
}
