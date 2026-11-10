import { Inject, Injectable } from '@nestjs/common';
import { _SAFE_DEPLOYMENTS } from '@safe-global/safe-deployments/dist/deployments';
import type { EntityManager } from 'typeorm';
import type { Address } from 'viem';
import { z } from 'zod';
import {
  getMultiSendCallOnlyDeployments,
  getMultiSendDeployments,
} from '@/domain/common/utils/deployments';
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

/** What `evaluate` needs, read on the caller's transaction (RLS: `app.org_id` set). */
@Injectable()
export class PolicyContextService {
  constructor(
    @Inject(IChainsRepository) private readonly chains: IChainsRepository,
  ) {}

  /** Active policies covering the Safe, at their latest version, in creation order. */
  async activePolicies(
    em: EntityManager,
    orgId: string,
    safe: { chainId: string; address: Address },
  ): Promise<Array<CompiledPolicy>> {
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
    return rows
      .filter((r) => inScope(PolicyScopeSchema.parse(r.scope), safe))
      .map((r) => ({
        id: r.id,
        name: r.name,
        version: r.version,
        configHash: r.config_hash,
        // evaluate compares lowercase strings: always go through the schema
        rules: StoredRulesSchema.parse(r.rules),
      }));
  }

  async context(
    em: EntityManager,
    orgId: string,
    chainId: string,
  ): Promise<EvalContext> {
    const contacts: Array<{ address: string }> = await em.query(
      `SELECT address::text AS address FROM contacts
        WHERE org_id = $1 AND tags @> ARRAY['allowed'] AND chain_ids @> ARRAY[$2::text]`,
      [orgId, chainId],
    );
    return {
      chainId,
      allowedRecipients: new Set(contacts.map((c) => c.address.toLowerCase())),
      trustedMultiSend: await this.trustedMultiSend(chainId),
    };
  }

  /** MultiSend and MultiSendCallOnly of every released version, plus the chain's configured ones. */
  private async trustedMultiSend(chainId: string): Promise<Set<string>> {
    const { contractAddresses } = await this.chains.getChain(chainId);
    const addresses = _SAFE_DEPLOYMENTS
      .flatMap(({ version }) => [
        ...getMultiSendDeployments({ chainId, version }),
        ...getMultiSendCallOnlyDeployments({ chainId, version }),
      ])
      .concat(
        [
          contractAddresses.multiSendAddress,
          contractAddresses.multiSendCallOnlyAddress,
        ].filter((a): a is Address => !!a),
      );
    return new Set(addresses.map((a) => a.toLowerCase()));
  }
}
