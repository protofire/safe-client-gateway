import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { getAddress, type Address } from 'viem';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';
import { mapLimit } from '@/modules/org/safes/map-limit';

/** Abuse limit (spec section 8), checked under the org row lock. */
export const MAX_LINKED_SAFES = 50;
const CONCURRENCY = 5;

export type LinkedSafeRow = {
  id: string;
  chainId: string;
  address: Address;
  label: string | null;
};

export type LinkedSafeView = LinkedSafeRow & {
  owners: Array<Address> | null;
  threshold: number | null;
  iAmSigner: boolean;
  error?: 'unavailable';
};

type Actor = { userId: string; ip?: string; userAgent?: string };

@Injectable()
export class LinkedSafesService {
  constructor(
    private readonly tx: OrgTransaction,
    private readonly activity: ActivityLog,
    @Inject(ISafeRepository) private readonly safes: ISafeRepository,
  ) {}

  async link(
    orgId: string,
    input: { chainId: string; address: Address; label?: string },
    actor: Actor,
  ): Promise<LinkedSafeRow> {
    const address = getAddress(input.address);
    // Outside the transaction: a slow tx-service must not hold the org lock
    let isSafe: boolean;
    try {
      isSafe = await this.safes.isSafe({ chainId: input.chainId, address });
    } catch {
      throw new BadGatewayException('Could not verify the Safe on this chain');
    }
    if (!isSafe) {
      throw new UnprocessableEntityException(
        'The address is not a Safe on this chain',
      );
    }

    return this.tx.runInOrgTx(async (em) => {
      await em.query(`SELECT 1 FROM organizations WHERE id = $1 FOR UPDATE`, [
        orgId,
      ]);
      const [{ count }] = await em.query(
        `SELECT count(*)::int AS count FROM linked_safes WHERE org_id = $1`,
        [orgId],
      );
      if (count >= MAX_LINKED_SAFES) {
        throw new ConflictException({
          statusCode: 409,
          message: `An organization can link at most ${MAX_LINKED_SAFES} Safes`,
          code: 'safe_limit',
        });
      }
      const inserted: Array<{ id: string }> = await em.query(
        `INSERT INTO linked_safes (org_id, chain_id, address, label)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_id, chain_id, address) DO NOTHING
         RETURNING id`,
        [orgId, input.chainId, address, input.label ?? null],
      );
      if (inserted.length === 0) {
        throw new ConflictException({
          statusCode: 409,
          message: 'This Safe is already linked',
          code: 'already_linked',
        });
      }
      const id = inserted[0].id;
      await this.activity.record(em, {
        orgId,
        actorUserId: actor.userId,
        type: 'safe.linked',
        targetType: 'safe',
        targetId: id,
        payload: {
          chainId: input.chainId,
          address,
          ...(input.label ? { label: input.label } : {}),
        },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      return {
        id,
        chainId: input.chainId,
        address,
        label: input.label ?? null,
      };
    }, orgId);
  }

  async unlink(
    orgId: string,
    linkedSafeId: string,
    actor: Actor,
  ): Promise<void> {
    await this.tx.runInOrgTx(async (em) => {
      const rows: Array<{
        chain_id: string;
        address: string;
        label: string | null;
      }> = await em.query(
        // CTE: a bare DELETE ... RETURNING resolves to [rows, count] in TypeORM
        `WITH d AS (
           DELETE FROM linked_safes WHERE id = $1 AND org_id = $2
           RETURNING chain_id, address, label
         ) SELECT chain_id, address, label FROM d`,
        [linkedSafeId, orgId],
      );
      if (rows.length === 0) throw new NotFoundException();
      const [row] = rows;
      await this.activity.record(em, {
        orgId,
        actorUserId: actor.userId,
        type: 'safe.unlinked',
        targetType: 'safe',
        targetId: linkedSafeId,
        payload: {
          chainId: row.chain_id,
          address: getAddress(row.address),
          ...(row.label ? { label: row.label } : {}),
        },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
    }, orgId);
  }

  async rows(orgId: string): Promise<Array<LinkedSafeRow>> {
    const rows: Array<{
      id: string;
      chain_id: string;
      address: string;
      label: string | null;
    }> = await this.tx.runInOrgTx(
      (em) =>
        em.query(
          `SELECT id, chain_id, address, label FROM linked_safes
            WHERE org_id = $1 ORDER BY created_at, id`,
          [orgId],
        ),
      orgId,
    );
    return rows.map((r) => ({
      id: r.id,
      chainId: r.chain_id,
      address: getAddress(r.address),
      label: r.label,
    }));
  }

  /** Lowercased wallet addresses of the caller; never stored on the Safe. */
  async wallets(userId: string): Promise<Set<string>> {
    const rows: Array<{ wallet_address: string }> = await this.tx.runInOrgTx(
      (em) =>
        em.query(
          `SELECT wallet_address FROM identities WHERE user_id = $1 AND kind = 'wallet'`,
          [userId],
        ),
    );
    return new Set(rows.map((r) => r.wallet_address.toLowerCase()));
  }

  async list(orgId: string, userId: string): Promise<Array<LinkedSafeView>> {
    const [rows, wallets] = await Promise.all([
      this.rows(orgId),
      this.wallets(userId),
    ]);
    return mapLimit(rows, CONCURRENCY, async (row) => {
      try {
        const safe = await this.safes.getSafe({
          chainId: row.chainId,
          address: row.address,
        });
        return {
          ...row,
          owners: safe.owners,
          threshold: safe.threshold,
          iAmSigner: safe.owners.some((o) => wallets.has(o.toLowerCase())),
        };
      } catch {
        return {
          ...row,
          owners: null,
          threshold: null,
          iAmSigner: false,
          error: 'unavailable' as const,
        };
      }
    });
  }
}
