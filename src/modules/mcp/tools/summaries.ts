import { z } from 'zod';
import { PaginationData } from '@/routes/common/pagination/pagination.data';
import { ExecutionInfoType } from '@/modules/transactions/routes/entities/execution-info.entity';
import type { MultisigExecutionInfo } from '@/modules/transactions/routes/entities/multisig-execution-info.entity';
import type { Transaction } from '@/modules/transactions/routes/entities/transaction.entity';
import { TRANSACTION_ID_SEPARATOR } from '@/modules/transactions/routes/constants';

export const PAGE_SIZE = 20;
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

export function describeTransaction(txInfo: Transaction['txInfo']): string {
  const { type, humanDescription } = txInfo;
  const { methodName } = txInfo as { methodName?: string | null };
  return oneLine(
    humanDescription ?? (methodName ? `${type}: ${methodName}` : type),
  );
}

/** CGW ids read `<type>_<safe>_<id>`; only multisig ids end in a safeTxHash. */
export function safeTxHashOf(id: string): string | null {
  const [type, , hash] = id.split(TRANSACTION_ID_SEPARATOR);
  return type === 'multisig' ? (hash ?? null) : null;
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
