import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { getAddress } from 'viem';
import { z } from 'zod';
import { DataSourceError } from '@/domain/errors/data-source.error';
import { ITransactionApiManager } from '@/domain/interfaces/transaction-api.manager.interface';
import { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import {
  AmountError,
  formatAmount,
  parseAmountStrict,
} from '@/modules/org/common/amounts';
import { OrgTransaction } from '@/modules/org/db/org-transaction';
import {
  conflict,
  lockOrgs,
  recheckPermission,
} from '@/modules/org/orgs/org-lock';
import type { Actor } from '@/modules/org/orgs/parse';
import { PermissionResolver } from '@/modules/org/permissions/permission.resolver';
import { configHash } from '@/modules/org/policies/config-hash';
import {
  MAX_POLICIES,
  PolicyRuleInputSchema,
  type Policy,
  type PolicyBody,
  type PolicyRuleInput,
  type PolicyRuleView,
  type RuleError,
} from '@/modules/org/policies/policies.schemas';
import {
  PolicyRuleSchema,
  PolicyScopeSchema,
  type PolicyRule,
  type PolicyScope,
} from '@/modules/org/policies/policy-rules';
import { mapLimit } from '@/modules/org/safes/map-limit';

type Row = {
  id: string;
  name: string;
  status: 'active' | 'disabled';
  current_version: number;
  updated_at: Date;
  config_hash: string;
  scope: unknown;
  rules: unknown;
};

const SELECT = `SELECT p.id, p.name, p.status, p.current_version, p.updated_at,
                       v.config_hash, v.scope, v.rules
                  FROM policies p
                  JOIN policy_versions v
                    ON v.org_id = p.org_id AND v.policy_id = p.id AND v.version = p.current_version`;

const StoredRulesSchema = z.array(PolicyRuleSchema);
const AMOUNT_REASONS: Record<AmountError['code'], string> = {
  too_many_decimals: 'More decimal places than the token has',
  invalid: 'Not a decimal number',
  zero: 'Must be greater than 0',
  overflow: 'Too large',
};

type StoredCap = Extract<PolicyRule, { kind: 'amount_cap' }>['caps'][number];
// four kinds, one rule each; a longer array is rejected before any rule is read
const MAX_RULES = 8;

/** The input amount is the stored cap, read with the stored decimals. */
function sameAmount(maxAmount: string, cap: StoredCap): boolean {
  try {
    return parseAmountStrict(maxAmount, cap.decimals).toString() === cap.maxRaw;
  } catch {
    return false;
  }
}

// only what a cap needs from the raw tx-service token; decimals may be absent upstream
const RawTokenSchema = z.object({
  type: z.string(),
  symbol: z.string(),
  decimals: z.number().int().nullish(),
});

type Resolved = { scope: PolicyScope; rules: Array<PolicyRule> };

function issues(prefix: string, error: z.ZodError): Array<RuleError> {
  return error.issues.map((i) => ({
    path: [prefix, ...i.path].join('.'),
    reason: i.message,
  }));
}

function invalidRules(errors: Array<RuleError>): UnprocessableEntityException {
  return new UnprocessableEntityException({
    statusCode: 422,
    message: 'The policy has invalid rules or scope',
    code: 'invalid_rules',
    errors: errors.slice(0, 100),
  });
}

function versionConflict(): ConflictException {
  return conflict(
    'version_conflict',
    'The policy was changed meanwhile; reload and try again',
  );
}

function toView(r: Row): Policy {
  const rules: Array<PolicyRuleView> = StoredRulesSchema.parse(r.rules).map(
    (rule) =>
      rule.kind === 'amount_cap'
        ? {
            ...rule,
            caps: rule.caps.map((c) => ({
              ...c,
              maxAmount: formatAmount(BigInt(c.maxRaw), c.decimals),
            })),
          }
        : rule,
  );
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    version: r.current_version,
    configHash: r.config_hash,
    scope: PolicyScopeSchema.parse(r.scope),
    rules,
    updatedAt: r.updated_at.toISOString(),
  };
}

@Injectable()
export class PoliciesService {
  constructor(
    private readonly tx: OrgTransaction,
    private readonly log: ActivityLog,
    private readonly resolver: PermissionResolver,
    @Inject(IChainsRepository) private readonly chains: IChainsRepository,
    @Inject(ITransactionApiManager)
    private readonly transactionApis: ITransactionApiManager,
  ) {}

  list(orgId: string): Promise<Array<Policy>> {
    return this.tx.runInOrgTx(async (em) => {
      const rows: Array<Row> = await em.query(
        `${SELECT} WHERE p.org_id = $1 AND p.status <> 'deleted' ORDER BY p.created_at, p.id`,
        [orgId],
      );
      return rows.map(toView);
    }, orgId);
  }

  async create(
    orgId: string,
    input: PolicyBody,
    actor: Actor,
  ): Promise<Policy> {
    // token and chain reads happen before the transaction: no lock held during HTTP
    const { scope, rules } = await this.resolve(input);
    const hash = configHash(scope, rules);
    return this.tx.runInOrgTx(async (em) => {
      await this.lock(em, orgId, actor.userId);
      await this.assertLinked(em, orgId, scope, []);
      // counted under the org lock, so two concurrent creates cannot both pass
      const [{ n }] = await em.query(
        `SELECT count(*)::int AS n FROM policies WHERE org_id = $1 AND status <> 'deleted'`,
        [orgId],
      );
      if (n >= MAX_POLICIES) {
        throw conflict(
          'policy_limit',
          `An organization holds at most ${MAX_POLICIES} policies`,
        );
      }
      const [{ id }]: Array<{ id: string }> = await this.guardName(() =>
        em.query(
          `INSERT INTO policies (org_id, name, status, created_by)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [
            orgId,
            input.name,
            input.enabled ? 'active' : 'disabled',
            actor.userId,
          ],
        ),
      );
      await this.insertVersion(em, orgId, id, 1, scope, rules, hash, actor);
      await this.event(em, orgId, 'policy.created', id, input.name, 1, actor);
      return this.find(em, orgId, id);
    }, orgId);
  }

  async update(
    orgId: string,
    id: string,
    input: PolicyBody & { expectedVersion: number },
    actor: Actor,
  ): Promise<Policy> {
    // unchanged caps keep their stored token metadata: no token read, no new version on an upstream symbol change
    const before = await this.tx.runInOrgTx(
      (em) => this.find(em, orgId, id),
      orgId,
    );
    const { scope, rules } = await this.resolve(input, before.rules);
    const hash = configHash(scope, rules);
    const status = input.enabled ? 'active' : 'disabled';
    return this.tx.runInOrgTx(async (em) => {
      await this.lock(em, orgId, actor.userId);
      const current = await this.find(em, orgId, id);
      if (current.version !== input.expectedVersion) throw versionConflict();
      // Safes already in the stored scope may have been unlinked since: keeping them is not a new choice
      await this.assertLinked(em, orgId, scope, current.scope.safes);
      if (
        current.configHash === hash &&
        current.status === status &&
        current.name === input.name
      ) {
        return current;
      }
      // TypeORM returns [rows, affected] for UPDATE ... RETURNING
      const [[row]]: Array<[{ current_version: number } | undefined]> =
        await this.guardName(() =>
          em.query(
            `UPDATE policies
                SET current_version = current_version + 1, name = $3, status = $4, updated_at = now()
              WHERE org_id = $1 AND id = $2 AND current_version = $5 AND status <> 'deleted'
              RETURNING current_version`,
            [orgId, id, input.name, status, input.expectedVersion],
          ),
        );
      if (!row) throw versionConflict();
      const version = row.current_version;
      await this.insertVersion(
        em,
        orgId,
        id,
        version,
        scope,
        rules,
        hash,
        actor,
      );
      await this.event(
        em,
        orgId,
        'policy.updated',
        id,
        input.name,
        version,
        actor,
      );
      return this.find(em, orgId, id);
    }, orgId);
  }

  remove(orgId: string, id: string, actor: Actor): Promise<void> {
    return this.tx.runInOrgTx(async (em) => {
      await this.lock(em, orgId, actor.userId);
      // versions stay: findings refer to them
      const [rows]: [Array<{ name: string }>, number] = await em.query(
        `UPDATE policies SET status = 'deleted', updated_at = now()
          WHERE org_id = $1 AND id = $2 AND status <> 'deleted' RETURNING name`,
        [orgId, id],
      );
      if (rows.length === 0) throw new NotFoundException('Policy not found');
      await this.event(
        em,
        orgId,
        'policy.deleted',
        id,
        rows[0].name,
        null,
        actor,
      );
    }, orgId);
  }

  // ---- helpers ----

  private async lock(
    em: EntityManager,
    orgId: string,
    userId: string,
  ): Promise<void> {
    await lockOrgs(em, [orgId]);
    // the guard checked before the lock wait; a concurrent demotion may have happened since
    await recheckPermission(this.resolver, em, orgId, userId, 'policies.write');
  }

  private async find(
    em: EntityManager,
    orgId: string,
    id: string,
  ): Promise<Policy> {
    const [row]: Array<Row> = await em.query(
      `${SELECT} WHERE p.org_id = $1 AND p.id = $2 AND p.status <> 'deleted'`,
      [orgId, id],
    );
    if (!row) throw new NotFoundException('Policy not found');
    return toView(row);
  }

  /** Validates scope and rules and resolves cap amounts to raw units; 422 `invalid_rules` with paths. */
  private async resolve(
    input: PolicyBody,
    stored: Array<PolicyRuleView> = [],
  ): Promise<Resolved> {
    const scope = PolicyScopeSchema.safeParse(input.scope);
    const parsed = z
      .array(PolicyRuleInputSchema)
      .min(1, 'A policy needs at least one rule')
      .max(MAX_RULES, `At most ${MAX_RULES} rules (one of each kind)`)
      .safeParse(input.rules);
    if (!scope.success || !parsed.success) {
      throw invalidRules([
        ...(scope.success ? [] : issues('scope', scope.error)),
        ...(parsed.success ? [] : issues('rules', parsed.error)),
      ]);
    }
    const errors: Array<RuleError> = [];
    const kinds = new Set<string>();
    parsed.data.forEach((rule, i) => {
      if (kinds.has(rule.kind)) {
        errors.push({
          path: `rules.${i}.kind`,
          reason: 'Only one rule of each kind per policy',
        });
      }
      kinds.add(rule.kind);
    });
    if (errors.length > 0) throw invalidRules(errors);

    const known = new Map(
      stored.flatMap((r) =>
        r.kind === 'amount_cap'
          ? r.caps.map((c) => [`${c.chainId}:${c.token}`, c] as const)
          : [],
      ),
    );
    const resolved: Array<unknown> = [];
    for (const [i, rule] of parsed.data.entries()) {
      resolved.push(await this.resolveRule(rule, i, known, errors));
    }
    if (errors.length > 0) throw invalidRules(errors);
    // the stored shape runs the B2 checks (duplicates, limits) on resolved values
    const rules = StoredRulesSchema.safeParse(resolved);
    if (!rules.success) throw invalidRules(issues('rules', rules.error));
    return { scope: scope.data, rules: rules.data };
  }

  private async resolveRule(
    rule: PolicyRuleInput,
    i: number,
    known: ReadonlyMap<string, StoredCap>,
    errors: Array<RuleError>,
  ): Promise<unknown> {
    if (rule.kind !== 'amount_cap') return rule;
    const caps = await mapLimit(
      rule.caps.map((cap, j) => ({ cap, path: `rules.${i}.caps.${j}` })),
      5,
      async ({ cap: { maxAmount, ...cap }, path }) => {
        const same = known.get(`${cap.chainId}:${cap.token}`);
        if (same && sameAmount(maxAmount, same)) {
          return {
            ...cap,
            maxRaw: same.maxRaw,
            decimals: same.decimals,
            symbol: same.symbol,
          };
        }
        const meta = await this.tokenMeta(cap.chainId, cap.token);
        if ('reason' in meta) {
          errors.push({ path: `${path}.${meta.field}`, reason: meta.reason });
          return null;
        }
        try {
          const maxRaw = parseAmountStrict(maxAmount, meta.decimals);
          return { ...cap, maxRaw: maxRaw.toString(), ...meta };
        } catch (e) {
          if (!(e instanceof AmountError)) throw e;
          errors.push({
            path: `${path}.maxAmount`,
            reason: AMOUNT_REASONS[e.code],
          });
          return null;
        }
      },
    );
    return { ...rule, caps };
  }

  private async tokenMeta(
    chainId: string,
    token: string,
  ): Promise<
    | { decimals: number; symbol: string }
    | { field: 'chainId' | 'token'; reason: string }
  > {
    try {
      if (token === 'native') {
        const { nativeCurrency } = await this.chains.getChain(chainId);
        return {
          decimals: nativeCurrency.decimals,
          symbol: nativeCurrency.symbol,
        };
      }
      const api = await this.transactionApis.getApi(chainId);
      const t = RawTokenSchema.parse(await api.getToken(getAddress(token)));
      if (t.type !== 'ERC20') {
        return { field: 'token', reason: 'Not an ERC20 token' };
      }
      // the gateway token schema turns absent decimals into 0: a cap must not guess
      if (t.decimals === null || t.decimals === undefined) {
        return { field: 'token', reason: 'Token decimals unknown' };
      }
      return { decimals: t.decimals, symbol: t.symbol };
    } catch (error) {
      if (error instanceof DataSourceError && error.code === 404) {
        return token === 'native'
          ? { field: 'chainId', reason: 'Unknown chain' }
          : { field: 'token', reason: 'Unknown token on this chain' };
      }
      throw new BadGatewayException('Could not read token details');
    }
  }

  private async assertLinked(
    em: EntityManager,
    orgId: string,
    scope: PolicyScope,
    keep: PolicyScope['safes'],
  ): Promise<void> {
    if (scope.safes.length === 0) return;
    // linked_safes has no RLS (A3): filter by org explicitly
    const rows: Array<{ chain_id: string; address: string }> = await em.query(
      `SELECT chain_id, lower(address::text) AS address FROM linked_safes WHERE org_id = $1`,
      [orgId],
    );
    const ok = new Set(
      [...rows.map((r) => `${r.chain_id}:${r.address}`)].concat(
        keep.map((s) => `${s.chainId}:${s.address}`),
      ),
    );
    const errors = scope.safes.flatMap((s, i) =>
      ok.has(`${s.chainId}:${s.address}`)
        ? []
        : [
            {
              path: `scope.safes.${i}`,
              reason: 'Not a Safe linked to this organization',
            },
          ],
    );
    if (errors.length > 0) throw invalidRules(errors);
  }

  private insertVersion(
    em: EntityManager,
    orgId: string,
    policyId: string,
    version: number,
    scope: PolicyScope,
    rules: Array<PolicyRule>,
    hash: string,
    actor: Actor,
  ): Promise<unknown> {
    return em.query(
      `INSERT INTO policy_versions (org_id, policy_id, version, scope, rules, config_hash, created_by)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7)`,
      [
        orgId,
        policyId,
        version,
        JSON.stringify(scope),
        JSON.stringify(rules),
        hash,
        actor.userId,
      ],
    );
  }

  private event(
    em: EntityManager,
    orgId: string,
    type: 'policy.created' | 'policy.updated' | 'policy.deleted',
    id: string,
    name: string,
    version: number | null,
    actor: Actor,
  ): Promise<void> {
    return this.log.record(em, {
      orgId,
      actorUserId: actor.userId,
      type,
      targetType: 'policy',
      targetId: id,
      payload: version === null ? { name } : { name, version },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
  }

  // the unique index (org_id, lower(name)) of live policies
  private async guardName<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const code =
        (e as { code?: string; driverError?: { code?: string } }).code ??
        (e as { driverError?: { code?: string } }).driverError?.code;
      if (code === '23505') {
        throw new ConflictException({
          statusCode: 409,
          message: 'A policy with this name already exists',
          code: 'policy_exists',
        });
      }
      throw e;
    }
  }
}
