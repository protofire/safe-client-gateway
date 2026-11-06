import { faker } from '@faker-js/faker';
import { getAddress, type Hex } from 'viem';
import { AuthPayload } from '@/modules/auth/domain/entities/auth-payload.entity';
import type { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { chainBuilder } from '@/modules/chains/domain/entities/__tests__/chain.builder';
import { multisigTransactionBuilder } from '@/modules/safe/domain/entities/__tests__/multisig-transaction.builder';
import { confirmationBuilder } from '@/modules/safe/domain/entities/__tests__/multisig-transaction-confirmation.builder';
import { safeBuilder } from '@/modules/safe/domain/entities/__tests__/safe.builder';
import type { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';
import { ShieldedAccessService } from '@/modules/transactions/routes/shielded-access.service';
import type { TransactionVerifierHelper } from '@/modules/transactions/routes/helpers/transaction-verifier.helper';

const chainsRepository = {
  getChain: jest.fn(),
} as jest.MockedObjectDeep<IChainsRepository>;

const safeRepository = {
  getSafe: jest.fn(),
} as jest.MockedObjectDeep<ISafeRepository>;

const transactionVerifier = {
  verifyApiTransaction: jest.fn(),
} as jest.MockedObjectDeep<TransactionVerifierHelper>;

describe('ShieldedAccessService', () => {
  const chainId = '5124';
  const owner = getAddress(faker.finance.ethereumAddress());
  const safe = safeBuilder().with('owners', [owner]).build();
  let target: ShieldedAccessService;

  function pendingTx(): ReturnType<
    ReturnType<typeof multisigTransactionBuilder>['build']
  > {
    return multisigTransactionBuilder()
      .with('safe', safe.address)
      .with('isExecuted', false)
      .with('data', faker.string.hexadecimal({ length: 136 }) as Hex)
      .with('confirmations', [confirmationBuilder().build()])
      .build();
  }

  beforeEach(() => {
    jest.resetAllMocks();
    target = new ShieldedAccessService(
      chainsRepository,
      safeRepository,
      transactionVerifier,
    );
    safeRepository.getSafe.mockResolvedValue(safe);
  });

  describe('isShielded', () => {
    it('is true for chain 5124 without loading the chain', async () => {
      await expect(target.isShielded('5124')).resolves.toBe(true);
      expect(chainsRepository.getChain).not.toHaveBeenCalled();
    });

    it('is true for a chain with the SHIELDED_EVM feature', async () => {
      chainsRepository.getChain.mockResolvedValue(
        chainBuilder().with('features', ['SHIELDED_EVM']).build(),
      );
      await expect(target.isShielded('1')).resolves.toBe(true);
    });

    it('is false for a chain without the SHIELDED_EVM feature', async () => {
      chainsRepository.getChain.mockResolvedValue(
        chainBuilder().with('features', ['SAFE_APPS']).build(),
      );
      await expect(target.isShielded('1')).resolves.toBe(false);
    });

    it('fails closed when the chain cannot be loaded', async () => {
      chainsRepository.getChain.mockRejectedValue(new Error('down'));
      await expect(target.isShielded('1')).resolves.toBe(true);
    });
  });

  describe('canReadCalldata', () => {
    it('is true for a current owner with a session for the chain', async () => {
      const authPayload = new AuthPayload({
        chain_id: chainId,
        signer_address: owner,
      });
      await expect(
        target.canReadCalldata({
          authPayload,
          chainId,
          safeAddress: safe.address,
        }),
      ).resolves.toBe(true);
    });

    it('compares addresses regardless of case', async () => {
      const authPayload = new AuthPayload({
        chain_id: chainId,
        signer_address: owner.toLowerCase() as `0x${string}`,
      });
      await expect(
        target.canReadCalldata({
          authPayload,
          chainId,
          safeAddress: safe.address,
        }),
      ).resolves.toBe(true);
    });

    it.each([
      ['anonymous', new AuthPayload()],
      [
        'a non-owner',
        new AuthPayload({
          chain_id: chainId,
          signer_address: getAddress(faker.finance.ethereumAddress()),
        }),
      ],
      [
        'an owner with a session for another chain',
        new AuthPayload({ chain_id: '1', signer_address: owner }),
      ],
    ])('is false for %s', async (_, authPayload) => {
      await expect(
        target.canReadCalldata({
          authPayload,
          chainId,
          safeAddress: safe.address,
        }),
      ).resolves.toBe(false);
    });

    it('is false when the Safe cannot be loaded', async () => {
      safeRepository.getSafe.mockRejectedValue(new Error('down'));
      const authPayload = new AuthPayload({
        chain_id: chainId,
        signer_address: owner,
      });
      await expect(
        target.canReadCalldata({
          authPayload,
          chainId,
          safeAddress: safe.address,
        }),
      ).resolves.toBe(false);
    });
  });

  describe('redactTransactions', () => {
    it('redacts a copy and leaves the input untouched', async () => {
      const tx = pendingTx();
      const snapshot = JSON.stringify(tx);

      const [result] = await target.redactTransactions({
        chainId,
        authPayload: new AuthPayload(),
        transactions: [tx],
      });

      expect(result).not.toBe(tx);
      expect(result.isExecuted).toBeUndefined();
      expect(result).toMatchObject({
        data: null,
        origin: null,
        signatures: null,
        confirmations: [expect.objectContaining({ signature: null })],
      });
      expect(JSON.stringify(tx)).toBe(snapshot);
    });

    it('verifies the original transaction before redacting it', async () => {
      const tx = pendingTx();

      const [result] = await target.redactTransactions({
        chainId,
        authPayload: new AuthPayload(),
        transactions: [tx],
      });

      expect(transactionVerifier.verifyApiTransaction).toHaveBeenCalledTimes(1);
      expect(transactionVerifier.verifyApiTransaction).toHaveBeenCalledWith({
        chainId,
        safe,
        transaction: tx,
      });
      expect(tx.data).not.toBeNull();
      expect(result.data).toBeNull();
    });

    it('fails when the original transaction does not verify', async () => {
      transactionVerifier.verifyApiTransaction.mockImplementation(() => {
        throw new Error('Invalid safeTxHash');
      });

      await expect(
        target.redactTransactions({
          chainId,
          authPayload: new AuthPayload(),
          transactions: [pendingTx()],
        }),
      ).rejects.toThrow('Invalid safeTxHash');
    });

    it('does not verify a transaction returned to an owner', async () => {
      await target.redactTransactions({
        chainId,
        authPayload: new AuthPayload({
          chain_id: chainId,
          signer_address: owner,
        }),
        transactions: [pendingTx()],
      });

      expect(transactionVerifier.verifyApiTransaction).not.toHaveBeenCalled();
    });

    it('checks ownership against the Safe of the transaction', async () => {
      const tx = pendingTx();
      await target.redactTransactions({
        chainId,
        authPayload: new AuthPayload({
          chain_id: chainId,
          signer_address: owner,
        }),
        transactions: [tx, pendingTx()],
      });

      expect(safeRepository.getSafe).toHaveBeenCalledTimes(1);
      expect(safeRepository.getSafe).toHaveBeenCalledWith({
        chainId,
        address: tx.safe,
      });
    });

    it('returns executed transactions unchanged', async () => {
      const tx = multisigTransactionBuilder().with('isExecuted', true).build();

      const [result] = await target.redactTransactions({
        chainId,
        authPayload: new AuthPayload(),
        transactions: [tx],
      });

      expect(result).toBe(tx);
    });

    it('returns pending transactions unchanged on a non-shielded chain', async () => {
      chainsRepository.getChain.mockResolvedValue(
        chainBuilder().with('features', []).build(),
      );
      const tx = pendingTx();

      const [result] = await target.redactTransactions({
        chainId: '1',
        authPayload: new AuthPayload(),
        transactions: [tx],
      });

      expect(result).toBe(tx);
    });

    it('always redacts a row already redacted by the Transaction Service', async () => {
      const tx = { ...pendingTx(), isExecuted: undefined };

      const [result] = await target.redactTransactions({
        chainId,
        authPayload: new AuthPayload({
          chain_id: chainId,
          signer_address: owner,
        }),
        transactions: [tx],
      });

      expect(result.isExecuted).toBeUndefined();
      expect(result.data).toBeNull();
      expect(transactionVerifier.verifyApiTransaction).not.toHaveBeenCalled();
    });

    it('ignores items that are not multisig transactions', async () => {
      const item = { txType: 'ETHEREUM_TRANSACTION', txHash: '0x1' };

      const [result] = await target.redactTransactions({
        chainId,
        authPayload: new AuthPayload(),
        transactions: [item],
      });

      expect(result).toBe(item);
    });
  });
});
