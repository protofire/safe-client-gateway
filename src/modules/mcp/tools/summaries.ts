import { type Address, formatUnits, getAddress, isAddress } from 'viem';
import { z } from 'zod';
import { PaginationData } from '@/routes/common/pagination/pagination.data';
import { ExecutionInfoType } from '@/modules/transactions/routes/entities/execution-info.entity';
import type { MultisigExecutionInfo } from '@/modules/transactions/routes/entities/multisig-execution-info.entity';
import type { Transaction } from '@/modules/transactions/routes/entities/transaction.entity';
import {
  isTransferTransactionInfo,
  TransferDirection,
  type TransferTransactionInfo,
} from '@/modules/transactions/routes/entities/transfer-transaction-info.entity';
import { isErc20Transfer } from '@/modules/transactions/routes/entities/transfers/erc20-transfer.entity';
import { isErc721Transfer } from '@/modules/transactions/routes/entities/transfers/erc721-transfer.entity';
import type { NativeCoinTransfer } from '@/modules/transactions/routes/entities/transfers/native-coin-transfer.entity';
import type { Transfer } from '@/modules/transactions/routes/entities/transfers/transfer.entity';
import { isSwapTransferTransactionInfo } from '@/modules/transactions/routes/swap-transfer-transaction-info.entity';
import { TRANSACTION_ID_SEPARATOR } from '@/modules/transactions/routes/constants';
import { AddressSchema } from '@/validation/entities/schemas/address.schema';
import { NumericStringSchema } from '@/validation/entities/schemas/numeric-string.schema';

export const PAGE_SIZE = 20;

export const chainIdField = NumericStringSchema.describe(
  'Chain id as a decimal string, from list_chains',
);
export const safeAddressField = AddressSchema.describe(
  'Address of the multisig account',
);
const MAX_DESCRIPTION_LENGTH = 200;
// The service only reads the cursor of this URL; it is never fetched
const ROUTE_URL = 'https://mcp.invalid/';

export const CursorSchema = z
  .string()
  .max(100)
  .optional()
  .describe('The cursor returned as next by the previous call');

/** The client may pick the offset only: the page size is ours. */
export function pageRequest(cursor: string | undefined): {
  routeUrl: URL;
  paginationData: PaginationData;
} {
  const { offset } = PaginationData.fromCursor(
    withCursor(new URL(ROUTE_URL), cursor ?? ''),
  );
  const paginationData = new PaginationData(
    PAGE_SIZE,
    Number.isSafeInteger(offset) && offset > 0 ? offset : 0,
  );
  const routeUrl = withCursor(
    new URL(ROUTE_URL),
    `limit=${paginationData.limit}&offset=${paginationData.offset}`,
  );
  return { routeUrl, paginationData };
}

export function nextCursor(next: string | null): string | null {
  return next === null ? null : new URL(next).searchParams.get('cursor');
}

function withCursor(url: URL, cursor: string): URL {
  url.searchParams.set('cursor', cursor);
  return url;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_DESCRIPTION_LENGTH
    ? `${flat.slice(0, MAX_DESCRIPTION_LENGTH)}...`
    : flat;
}

/** Token amounts are decimals-adjusted when decimals are known, else base units. */
function assetOf(transfer: Transfer): string {
  if (isErc20Transfer(transfer)) {
    const token = transfer.tokenSymbol ?? transfer.tokenAddress;
    // The schema allows any string; only an integer can be formatted
    return typeof transfer.decimals !== 'number' ||
      !/^\d+$/.test(transfer.value)
      ? `${transfer.value} base units of ${token}`
      : `${formatUnits(BigInt(transfer.value), transfer.decimals)} ${token}`;
  }
  if (isErc721Transfer(transfer)) {
    return `${transfer.tokenSymbol ?? transfer.tokenAddress} #${transfer.tokenId}`;
  }
  const { value } = transfer as NativeCoinTransfer;
  return value === null
    ? 'an unknown amount of native coin'
    : `${value} wei of native coin`;
}

function describeTransfer(info: TransferTransactionInfo): string {
  const { transferInfo, direction, sender, recipient } = info;
  const counterparty = {
    [TransferDirection.Incoming]: `from ${sender.value}`,
    [TransferDirection.Outgoing]: `to ${recipient.value}`,
    [TransferDirection.Unknown]: `from ${sender.value} to ${recipient.value}`,
  }[direction];
  return `${direction} transfer of ${assetOf(transferInfo)} ${counterparty}`;
}

export function describeTransaction(txInfo: Transaction['txInfo']): string {
  const { type, humanDescription } = txInfo;
  const { methodName } = txInfo as { methodName?: string | null };
  if (humanDescription) {
    return oneLine(humanDescription);
  }
  if (
    isTransferTransactionInfo(txInfo) ||
    isSwapTransferTransactionInfo(txInfo)
  ) {
    return oneLine(describeTransfer(txInfo));
  }
  return oneLine(methodName ? `${type}: ${methodName}` : type);
}

/** CGW ids read `<type>_<safe>_<id>`; only multisig ids end in a safeTxHash. */
export function safeTxHashOf(id: string): string | null {
  const [type, , hash] = id.split(TRANSACTION_ID_SEPARATOR);
  return type === 'multisig' ? (hash ?? null) : null;
}

/** The checksummed account address in a CGW id, or null for a bare hash. */
export function safeAddressOfTxId(id: string): Address | null {
  const [, address] = id.split(TRANSACTION_ID_SEPARATOR);
  return address !== undefined && isAddress(address)
    ? getAddress(address)
    : null;
}

export function summarizeTransaction(transaction: Transaction): {
  id: string;
  safeTxHash: string | null;
  status: string;
  nonce: number | null;
  description: string;
  confirmations: number | null;
  threshold: number | null;
  timestamp: number;
} {
  const info =
    transaction.executionInfo?.type === ExecutionInfoType.Multisig
      ? (transaction.executionInfo as MultisigExecutionInfo)
      : null;
  return {
    id: transaction.id,
    safeTxHash: safeTxHashOf(transaction.id),
    status: transaction.txStatus,
    nonce: info?.nonce ?? null,
    description: describeTransaction(transaction.txInfo),
    confirmations: info?.confirmationsSubmitted ?? null,
    threshold: info?.confirmationsRequired ?? null,
    timestamp: transaction.timestamp,
  };
}
