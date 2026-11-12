import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { Address } from 'viem';
import { z } from 'zod';
import {
  getMultiSendCallOnlyDeployments,
  getMultiSendDeployments,
  getSafeVersions,
} from '@/domain/common/utils/deployments';
import {
  type ILoggingService,
  LoggingService,
} from '@/logging/logging.interface';
import { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import type { EvalContext } from '@/modules/org/policies/evaluate';
import {
  PolicyRuleSchema,
  PolicyScopeSchema,
  type CompiledPolicy,
  type PolicyScope,
} from '@/modules/org/policies/policy-rules';

const StoredRulesSchema = z.array(PolicyRuleSchema);

/** The `(chainId, address)` or the chain is listed; both lists empty = whole org. */
export function inScope(
  scope: PolicyScope,
  safe: { chainId: string; address: string },
): boolean {
  if (scope.safes.length === 0 && scope.chainIds.length === 0) return true;
  const address = safe.address.toLowerCase();
  return (
    scope.chainIds.includes(safe.chainId) ||
    scope.safes.some((s) => s.chainId === safe.chainId && s.address === address)
  );
}

/**
 * What `evaluate` needs. `activePolicies` and `context` read on the caller's
 * transaction (RLS: `app.org_id` set); `trustedMultiSend` does HTTP and must
 * be called before the transaction opens.
 */
@Injectable()
export class PolicyContextService {
  constructor(
    @Inject(IChainsRepository) private readonly chains: IChainsRepository,
    @Inject(LoggingService) private readonly logger: ILoggingService,
  ) {}

  /** Active policies covering the Safe, at their latest version, in creation order. */
  async activePolicies(
    em: EntityManager,
    orgId: string,
    safe: { chainId: string; address: Address },
  ): Promise<Array<CompiledPolicy>> {
    return (await this.orgPolicies(em, orgId))
      .filter((p) => inScope(p.scope, safe))
      .map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        configHash: p.configHash,
        rules: p.rules,
      }));
  }

  /** All active policies of the org with their scope, for callers that filter many Safes. */
  async orgPolicies(
    em: EntityManager,
    orgId: string,
  ): Promise<Array<CompiledPolicy & { scope: PolicyScope }>> {
    const rows: Array<{
      id: string;
      name: string;
      version: number;
      config_hash: string;
      scope: unknown;
      rules: unknown;
    }> = await em.query(
      `SELECT p.id, p.name, v.version, v.config_hash, v.scope, v.rules
         FROM policies p
         JOIN policy_versions v
           ON v.org_id = p.org_id AND v.policy_id = p.id AND v.version = p.current_version
        WHERE p.org_id = $1 AND p.status = 'active'
        ORDER BY p.created_at, p.id`,
      [orgId],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      version: r.version,
      configHash: r.config_hash,
      scope: PolicyScopeSchema.parse(r.scope),
      // evaluate compares lowercase strings: always go through the schema
      rules: StoredRulesSchema.parse(r.rules),
    }));
  }

  /** `trustedMultiSend`: the result of {@link trustedMultiSend}, read before the transaction. */
  async context(
    em: EntityManager,
    orgId: string,
    chainId: string,
    trustedMultiSend: ReadonlySet<string>,
  ): Promise<EvalContext> {
    const contacts: Array<{ address: string }> = await em.query(
      `SELECT address::text AS address FROM contacts
        WHERE org_id = $1 AND tags @> ARRAY['allowed'] AND chain_ids @> ARRAY[$2::text]`,
      [orgId, chainId],
    );
    return {
      chainId,
      allowedRecipients: new Set(contacts.map((c) => c.address.toLowerCase())),
      trustedMultiSend,
    };
  }

  /**
   * MultiSend and MultiSendCallOnly of every version (lowercase); the chain's
   * configured ones only where safe-deployments has none (custom chains).
   * Throws if the chain config cannot be read: without it a custom MultiSend
   * would raise false warnings.
   */
  async trustedMultiSend(chainId: string): Promise<ReadonlySet<string>> {
    const { contractAddresses } = await this.chains.getChain(chainId);
    const official = new Set(
      getSafeVersions()
        .flatMap((version) => [
          ...getMultiSendDeployments({ chainId, version }),
          ...getMultiSendCallOnlyDeployments({ chainId, version }),
        ])
        .map((a) => a.toLowerCase()),
    );
    const trusted = new Set(official);
    for (const a of [
      contractAddresses.multiSendAddress,
      contractAddresses.multiSendCallOnlyAddress,
    ]) {
      if (!a || official.has(a.toLowerCase())) continue;
      // a wrong config entry would hide delegatecalls from policies: ignored where deployments exist
      this.logger.error(
        `Chain ${chainId} config MultiSend ${a} is not a safe-deployments address${official.size > 0 ? '; ignored' : ''}`,
      );
      if (official.size === 0) trusted.add(a.toLowerCase());
    }
    return trusted;
  }
}
