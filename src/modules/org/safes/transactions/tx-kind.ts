import {
  isAddressEqual,
  size,
  slice,
  toFunctionSelector,
  type Address,
  type Hex,
} from 'viem';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import { unpackMultiSend } from '@/modules/org/common/multisend';

export const KINDS = [
  'transfer',
  'settings',
  'batch',
  'rejection',
  'contract',
] as const;
export type Kind = (typeof KINDS)[number];

const selectors = (signatures: Array<string>): Set<Hex> =>
  new Set(signatures.map((s) => toFunctionSelector(`function ${s}`)));

const SETTINGS = selectors([
  'addOwnerWithThreshold(address,uint256)',
  'removeOwner(address,address,uint256)',
  'swapOwner(address,address,address)',
  'changeThreshold(uint256)',
  'enableModule(address)',
  'disableModule(address,address)',
  'setGuard(address)',
  'setModuleGuard(address)',
  'setFallbackHandler(address)',
  'changeMasterCopy(address)',
]);

const TRANSFERS = selectors([
  'transfer(address,uint256)',
  'transferFrom(address,address,uint256)',
  'safeTransferFrom(address,address,uint256)',
  'safeTransferFrom(address,address,uint256,bytes)',
  'safeTransferFrom(address,address,uint256,uint256,bytes)',
]);

/** Spec 027 §4: classifies a raw multisig transaction, rules in order. */
export function txKind(
  tx: Pick<MultisigTransaction, 'to' | 'value' | 'data'>,
  safeAddress: Address,
): Kind {
  const data: Hex = tx.data ?? '0x';
  const empty = size(data) === 0;
  const selector = size(data) >= 4 ? slice(data, 0, 4) : null;
  const toSelf = isAddressEqual(tx.to, safeAddress);
  if (!empty && unpackMultiSend(data) !== null) return 'batch';
  if (toSelf && empty && BigInt(tx.value) === 0n) return 'rejection';
  if (toSelf && selector !== null && SETTINGS.has(selector)) return 'settings';
  if (
    empty ? BigInt(tx.value) > 0n : selector !== null && TRANSFERS.has(selector)
  )
    return 'transfer';
  return 'contract';
}
