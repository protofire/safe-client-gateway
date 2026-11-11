import { Inject, Injectable, Optional } from '@nestjs/common';
import { getAddress, isAddressEqual, zeroAddress, type Address } from 'viem';
import { IDelegatesV2Repository } from '@/modules/delegate/domain/v2/delegates.v2.repository.interface';
import { Clock, type IClock } from '@/modules/org/common/clock';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import {
  inScope,
  PolicyContextService,
} from '@/modules/org/policies/policy-context.service';
import {
  CONCURRENCY,
  DEFAULT_SAFE_TIMEOUT_MS,
  OVERVIEW_SAFE_TIMEOUT_MS,
  withDeadline,
} from '@/modules/org/safes/overview.service';
import { mapLimit } from '@/modules/org/safes/map-limit';
import { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';

/** A covering policy with no successful scan for this long is reported stale. */
const SCAN_STALE_MS = 30 * 60_000;
const DELEGATES_PAGE = 100;
// shortcut: at most 10 pages (1000 delegate rows) per Safe, raise if a Safe needs more
const MAX_DELEGATE_PAGES = 10;

export type ControlsSafe = {
  linkedSafeId: string;
  chainId: string;
  address: Address;
  label: string | null;
  version: string | null;
  owners: Array<Address>;
  threshold: number;
  guard: Address | null;
  modules: Array<Address>;
  fallbackHandler: Address | null;
  proposers: Array<Address>;
  policies: Array<{ id: string; name: string; version: number }>;
  policyStatus: 'checked_in_app_only' | 'no_policies';
  openFindings: number;
  scanStatus: {
    lastSuccessAt: string | null;
    lastErrorAt: string | null;
    stale: boolean;
  };
  error?: 'unavailable';
};

type DbPart = Pick<
  ControlsSafe,
  | 'linkedSafeId'
  | 'chainId'
  | 'address'
  | 'label'
  | 'policies'
  | 'policyStatus'
  | 'openFindings'
  | 'scanStatus'
>;

type ChainPart = Pick<
  ControlsSafe,
  | 'version'
  | 'owners'
  | 'threshold'
  | 'guard'
  | 'modules'
  | 'fallbackHandler'
  | 'proposers'
>;

const nonZero = (a: Address | null | undefined): Address | null =>
  a && !isAddressEqual(a, zeroAddress) ? a : null;

@Injectable()
export class ControlsService {
  constructor(
    private readonly tx: OrgTransaction,
    private readonly context: PolicyContextService,
    @Inject(ISafeRepository) private readonly safes: ISafeRepository,
    @Inject(IDelegatesV2Repository)
    private readonly delegates: IDelegatesV2Repository,
    @Inject(Clock) private readonly clock: IClock,
    @Optional()
    @Inject(OVERVIEW_SAFE_TIMEOUT_MS)
    private readonly safeTimeoutMs: number = DEFAULT_SAFE_TIMEOUT_MS,
  ) {}

  async list(orgId: string): Promise<Array<ControlsSafe>> {
    const parts = await this.dbParts(orgId);
    return mapLimit(parts, CONCURRENCY, async (part) => {
      try {
        return {
          ...part,
          ...(await withDeadline(this.onChain(part), this.safeTimeoutMs)),
        };
      } catch {
        return {
          ...part,
          version: null,
          owners: [],
          threshold: 0,
          guard: null,
          modules: [],
          fallbackHandler: null,
          proposers: [],
          error: 'unavailable' as const,
        };
      }
    });
  }

  /** Everything the org database knows, in one transaction and without HTTP. */
  private dbParts(orgId: string): Promise<Array<DbPart>> {
    const now = this.clock.now().getTime();
    return this.tx.runInOrgTx(async (em) => {
      const rows: Array<{
        id: string;
        chain_id: string;
        address: string;
        label: string | null;
      }> = await em.query(
        `SELECT id, chain_id, address, label FROM linked_safes
          WHERE org_id = $1 ORDER BY created_at, id`,
        [orgId],
      );
      if (rows.length === 0) return [];
      const findings: Array<{ linked_safe_id: string; open: number }> =
        await em.query(
          `SELECT linked_safe_id, count(*)::int AS open FROM policy_findings
            WHERE org_id = $1 AND resolved_at IS NULL GROUP BY linked_safe_id`,
          [orgId],
        );
      const scans: Array<{
        chain_id: string;
        address: string;
        last_success_at: Date | null;
        last_error_at: Date | null;
      }> = await em.query(
        `SELECT s.chain_id, s.address::text AS address, s.last_success_at, s.last_error_at
           FROM policy_scan_state s
           JOIN unnest($1::text[], $2::text[]) AS t(chain_id, address)
             ON s.chain_id = t.chain_id AND s.address = t.address::citext`,
        [rows.map((r) => r.chain_id), rows.map((r) => r.address)],
      );
      const open = new Map(findings.map((f) => [f.linked_safe_id, f.open]));
      const scanOf = new Map(
        scans.map((s) => [`${s.chain_id}:${s.address.toLowerCase()}`, s]),
      );

      const active = await this.context.orgPolicies(em, orgId);
      const out: Array<DbPart> = [];
      for (const r of rows) {
        const address = getAddress(r.address);
        const policies = active
          .filter((p) => inScope(p.scope, { chainId: r.chain_id, address }))
          .map((p) => ({ id: p.id, name: p.name, version: p.version }));
        // scan state is shared across orgs: only shown where this org has a covering policy
        const scan =
          policies.length > 0
            ? scanOf.get(`${r.chain_id}:${address.toLowerCase()}`)
            : undefined;
        const lastSuccess = scan?.last_success_at ?? null;
        out.push({
          linkedSafeId: r.id,
          chainId: r.chain_id,
          address,
          label: r.label,
          policies,
          policyStatus:
            policies.length > 0 ? 'checked_in_app_only' : 'no_policies',
          openFindings: open.get(r.id) ?? 0,
          scanStatus: {
            lastSuccessAt: lastSuccess?.toISOString() ?? null,
            lastErrorAt: scan?.last_error_at?.toISOString() ?? null,
            stale:
              policies.length > 0 &&
              (lastSuccess === null ||
                now - lastSuccess.getTime() > SCAN_STALE_MS),
          },
        });
      }
      return out;
    }, orgId);
  }

  private async onChain(part: DbPart): Promise<ChainPart> {
    const [safe, proposers] = await Promise.all([
      this.safes.getSafe({ chainId: part.chainId, address: part.address }),
      this.proposers(part),
    ]);
    return {
      version: safe.version ?? null,
      owners: safe.owners,
      threshold: safe.threshold,
      guard: nonZero(safe.guard),
      modules: safe.modules ?? [],
      fallbackHandler: nonZero(safe.fallbackHandler),
      proposers,
    };
  }

  private async proposers(part: DbPart): Promise<Array<Address>> {
    const found = new Set<Address>();
    for (let page = 0; page < MAX_DELEGATE_PAGES; page++) {
      const res = await this.delegates.getDelegates({
        chainId: part.chainId,
        safeAddress: part.address,
        limit: DELEGATES_PAGE,
        offset: page * DELEGATES_PAGE,
      });
      for (const d of res.results) found.add(d.delegate);
      if (!res.next) break;
    }
    return [...found];
  }
}
