import { getAddress, numberToHex, type Address } from 'viem';
import type { IConfigurationService } from '@/config/configuration.service.interface';
import type { ILoggingService } from '@/logging/logging.interface';
import type { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { DataDecoderRepository } from '@/modules/data-decoder/domain/v2/data-decoder.repository';
import type { IDataDecoderRepository } from '@/modules/data-decoder/domain/v2/data-decoder.repository.interface';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import type { Safe } from '@/modules/safe/domain/entities/safe.entity';
import type { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';
import { TransactionVerifierHelper } from '@/modules/transactions/routes/helpers/transaction-verifier.helper';
import type { MultisigTransactionMapper } from '@/modules/transactions/routes/mappers/multisig-transactions/multisig-transaction.mapper';
import type { LinkedSafesService } from '@/modules/org/safes/linked-safes.service';
import {
  OrgTransactionsService,
  type TransactionsBudget,
} from '@/modules/org/safes/transactions/org-transactions.service';
import {
  T0,
  executed,
  linked,
  settingsData,
} from '@/modules/org/safes/transactions/__tests__/model';

const ME = getAddress(numberToHex(0x1001, { size: 20 }));
const SAFE = linked('00000000-0000-4000-8000-000000000001', '1', 0xa1);
const page = (
  results: Array<MultisigTransaction>,
): {
  count: number;
  next: null;
  previous: null;
  results: Array<MultisigTransaction>;
} => ({ count: results.length, next: null, previous: null, results });
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

/** A queued transaction whose safeTxHash does not match its fields. */
const queuedTx = (): MultisigTransaction =>
  executed(SAFE, 3, null, {
    isExecuted: false,
    isSuccessful: null,
    executor: null,
    submissionDate: new Date(T0 * 1000),
    confirmationsRequired: 2,
    confirmations: [],
  });

function setup(
  opts: {
    safes?: Array<typeof SAFE>;
    budget?: Partial<TransactionsBudget>;
    decoder?: IDataDecoderRepository;
    mapTransaction?: MultisigTransactionMapper['mapTransaction'];
  } = {},
): {
  service: OrgTransactionsService;
  repo: {
    getSafe: jest.Mock;
    getTransactionQueueBySubmission: jest.Mock;
    getMultisigTransactions: jest.Mock;
  };
  mapTransaction: jest.Mock;
} {
  const repo = {
    getSafe: jest.fn(({ address }: { address: Address }) =>
      Promise.resolve({
        address,
        nonce: 0,
        threshold: 2,
        owners: [ME],
        version: '1.3.0',
      } as unknown as Safe),
    ),
    getTransactionQueueBySubmission: jest.fn(() => Promise.resolve(page([]))),
    getMultisigTransactions: jest.fn(() => Promise.resolve(page([]))),
  };
  const linkedSafes = {
    rows: jest.fn(() => Promise.resolve(opts.safes ?? [SAFE])),
    wallets: jest.fn(() => Promise.resolve(new Set([ME.toLowerCase()]))),
  };
  const chains = {
    getChain: jest.fn(() => Promise.resolve({ isTestnet: false })),
  };
  const decoder = opts.decoder ?? {
    getDecodedData: jest.fn(),
    getTransactionDataDecoded: jest.fn(() => Promise.resolve(null)),
  };
  const mapTransaction = jest.fn(
    opts.mapTransaction ??
      ((_c: string, tx: MultisigTransaction): Promise<never> =>
        Promise.resolve({ id: tx.safeTxHash } as never)),
  );
  const service = new OrgTransactionsService(
    linkedSafes as unknown as LinkedSafesService,
    repo as unknown as ISafeRepository,
    chains as unknown as IChainsRepository,
    decoder,
    { mapTransaction } as unknown as MultisigTransactionMapper,
    undefined,
    opts.budget,
  );
  return { service, repo, mapTransaction };
}

const logger = {
  warn: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
} as unknown as ILoggingService;

/** The gateway verifier with API hash and signature checks on. */
function verifier(): TransactionVerifierHelper {
  const config = {
    getOrThrow: (key: string): boolean => key.endsWith('.api'),
  } as unknown as IConfigurationService;
  return new TransactionVerifierHelper(
    config,
    {} as never,
    logger,
    {} as never,
    { getBlocklist: () => [] } as never,
  );
}

describe('OrgTransactionsService', () => {
  describe('failure semantics (spec §4)', () => {
    it('a decoder outage still maps the row, with no decoded data', async () => {
      const api = {
        getDecodedData: jest.fn(() => Promise.reject(new Error('down'))),
      };
      const tx = executed(SAFE, 1, T0, { data: settingsData });
      const { service, repo, mapTransaction } = setup({
        decoder: new DataDecoderRepository(api as never, logger),
      });
      repo.getMultisigTransactions.mockResolvedValue(page([tx]));

      const res = await service.list('org', 'user', {
        tab: 'history',
        limit: 25,
      });

      expect(api.getDecodedData).toHaveBeenCalled();
      expect(mapTransaction).toHaveBeenCalledWith(
        '1',
        tx,
        expect.objectContaining({ address: SAFE.address }),
        null,
      );
      expect(res.items[0].transaction).toEqual({ id: tx.safeTxHash });
    });

    it('a verifier rejection of a queued row gives transaction null and keeps the row', async () => {
      const check = verifier();
      const tx = queuedTx();
      const { service, repo } = setup({
        mapTransaction: (chainId, transaction, safe) => {
          check.verifyApiTransaction({ chainId, safe, transaction });
          return Promise.resolve({ id: 'mapped' } as never);
        },
      });
      repo.getTransactionQueueBySubmission.mockResolvedValue(page([tx]));

      const res = await service.list('org', 'user', {
        tab: 'queue',
        limit: 25,
      });

      expect(res.items).toHaveLength(1);
      expect(res.items[0]).toMatchObject({
        safeTxHash: tx.safeTxHash,
        status: 'awaiting_confirmations',
        transaction: null,
      });
      expect(res.complete).toBe(true);
    });

    it('never rejects an executed row, whatever its hash', async () => {
      const check = verifier();
      const tx = { ...queuedTx(), ...executed(SAFE, 3, T0) };
      const { service, repo } = setup({
        mapTransaction: (chainId, transaction, safe) => {
          check.verifyApiTransaction({ chainId, safe, transaction });
          return Promise.resolve({ id: 'mapped' } as never);
        },
      });
      repo.getMultisigTransactions.mockResolvedValue(page([tx]));

      const res = await service.list('org', 'user', {
        tab: 'history',
        limit: 25,
      });

      expect(res.items[0].transaction).toEqual({ id: 'mapped' });
    });
  });

  describe('budget (spec §5)', () => {
    const many = Array.from({ length: 3 }, (_, i) =>
      linked(`00000000-0000-4000-8000-00000000001${i}`, '1', 0xb0 + i),
    );
    // the whole budget is the mapping reserve: the fan-out window is already over
    const expired = { totalMs: 100, mappingReserveMs: 100, safeMs: 8_000 };

    it.each(['queue', 'history'] as const)(
      'starts no Safe read after the fan-out window (%s)',
      async (tab) => {
        const { service, repo } = setup({ safes: many, budget: expired });

        const res = await service.list('org', 'user', { tab, limit: 25 });

        expect(repo.getSafe).not.toHaveBeenCalled();
        expect(repo.getTransactionQueueBySubmission).not.toHaveBeenCalled();
        expect(repo.getMultisigTransactions).not.toHaveBeenCalled();
        expect(res.complete).toBe(false);
        expect(res.unavailableSafeIds).toEqual(many.map((s) => s.id));
      },
    );

    it('starts no Safe read for the counts after the fan-out window', async () => {
      const { service, repo } = setup({ safes: many, budget: expired });

      const counts = await service.counts('org', 'user', {});

      expect(repo.getSafe).not.toHaveBeenCalled();
      expect(counts).toEqual({ queued: 0, awaitingMe: 0, complete: false });
    });

    it('answers rows not mapped within the budget with transaction null; complete stays true', async () => {
      const txs = [executed(SAFE, 2, T0), executed(SAFE, 1, T0 - 1)];
      const { service, repo, mapTransaction } = setup({
        budget: { totalMs: 300, mappingReserveMs: 200, safeMs: 8_000 },
        mapTransaction: () => never(),
      });
      repo.getMultisigTransactions.mockResolvedValue(page(txs));

      const started = Date.now();
      const res = await service.list('org', 'user', {
        tab: 'history',
        limit: 25,
      });

      expect(Date.now() - started).toBeLessThan(1_000);
      expect(mapTransaction).toHaveBeenCalledTimes(2);
      expect(res.items.map((r) => [r.nonce, r.transaction])).toEqual([
        [2, null],
        [1, null],
      ]);
      expect(res.complete).toBe(true);
    });
  });
});
