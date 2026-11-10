import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import type { Safe } from '@/modules/safe/domain/entities/safe.entity';
import type { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';

const QUEUE_PAGE_SIZE = 20;
const DEFAULT_MAX = 100;

/**
 * Reads queued transactions from `offset` until `max` are collected or the
 * queue ends. `nextOffset` is where the next read continues, or null when
 * the queue ended within this read.
 */
export async function readQueue(
  safes: ISafeRepository,
  chainId: string,
  safe: Safe,
  opts: { offset?: number; max?: number; trusted?: boolean } = {},
): Promise<{ queued: Array<MultisigTransaction>; nextOffset: number | null }> {
  const max = opts.max ?? DEFAULT_MAX;
  const queued: Array<MultisigTransaction> = [];
  for (let offset = opts.offset ?? 0; ; ) {
    const page = await safes.getTransactionQueue({
      chainId,
      safe,
      limit: QUEUE_PAGE_SIZE,
      offset,
      ...(opts.trusted === undefined ? {} : { trusted: opts.trusted }),
    });
    queued.push(...page.results);
    offset += QUEUE_PAGE_SIZE;
    if (page.next === null || page.results.length === 0) {
      return { queued, nextOffset: null };
    }
    if (queued.length >= max) return { queued, nextOffset: offset };
  }
}
