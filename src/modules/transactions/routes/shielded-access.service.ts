import { Inject, Injectable } from '@nestjs/common';
import { isAddressEqual, type Address } from 'viem';
import { AuthPayload } from '@/modules/auth/domain/entities/auth-payload.entity';
import { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import { ISafeRepository } from '@/modules/safe/domain/safe.repository.interface';
import { TransactionVerifierHelper } from '@/modules/transactions/routes/helpers/transaction-verifier.helper';

/**
 * On shielded chains, the calldata of an unexecuted multisig transaction is
 * only returned to a caller with a valid SIWE session for the chain whose
 * signer is a current owner of the transaction's Safe.
 */
@Injectable()
export class ShieldedAccessService {
  private static readonly SHIELDED_EVM_FEATURE = 'SHIELDED_EVM';
  private static readonly SEISMIC_CHAIN_ID = '5124';

  constructor(
    @Inject(IChainsRepository)
    private readonly chainsRepository: IChainsRepository,
    @Inject(ISafeRepository)
    private readonly safeRepository: ISafeRepository,
    private readonly transactionVerifier: TransactionVerifierHelper,
  ) {}

  async isShielded(chainId: string): Promise<boolean> {
    if (chainId === ShieldedAccessService.SEISMIC_CHAIN_ID) {
      return true;
    }
    return this.chainsRepository
      .getChain(chainId)
      .then((chain) => {
        return chain.features.includes(
          ShieldedAccessService.SHIELDED_EVM_FEATURE,
        );
      })
      .catch(() => true);
  }

  async canReadCalldata(args: {
    authPayload: AuthPayload;
    chainId: string;
    safeAddress: Address;
  }): Promise<boolean> {
    const signer = args.authPayload.signer_address;
    if (!signer || !args.authPayload.isForChain(args.chainId)) {
      return false;
    }
    return this.safeRepository
      .getSafe({ chainId: args.chainId, address: args.safeAddress })
      .then((safe) => {
        return safe.owners.some((owner) => isAddressEqual(owner, signer));
      })
      .catch(() => false);
  }

  /**
   * Returns the transactions with every unexecuted multisig transaction the
   * caller may not read replaced by a redacted copy. Rows already redacted by
   * the Transaction Service (no `isExecuted`) are always redacted. The input
   * objects are never mutated as they may be cached.
   */
  async redactTransactions<T extends object>(args: {
    chainId: string;
    authPayload: AuthPayload;
    transactions: Array<T>;
  }): Promise<Array<T>> {
    let isShielded: Promise<boolean> | undefined;
    const canReadBySafe = new Map<Address, Promise<boolean>>();

    return Promise.all(
      args.transactions.map(async (transaction) => {
        if (
          !this.isMultisigTransaction(transaction) ||
          transaction.isExecuted === true
        ) {
          return transaction;
        }
        if (transaction.isExecuted === false) {
          isShielded ??= this.isShielded(args.chainId);
          if (!(await isShielded)) {
            return transaction;
          }
          // The owner check uses the Safe of the loaded transaction, never an id from the URL
          let canRead = canReadBySafe.get(transaction.safe);
          if (!canRead) {
            canRead = this.canReadCalldata({
              authPayload: args.authPayload,
              chainId: args.chainId,
              safeAddress: transaction.safe,
            });
            canReadBySafe.set(transaction.safe, canRead);
          }
          if (await canRead) {
            return transaction;
          }
          // The mappers only see the redacted copy, so verify the original here
          this.transactionVerifier.verifyApiTransaction({
            chainId: args.chainId,
            safe: await this.safeRepository.getSafe({
              chainId: args.chainId,
              address: transaction.safe,
            }),
            transaction,
          });
        }
        return this.redact(transaction);
      }),
    );
  }

  async redactTransaction<T extends MultisigTransaction>(args: {
    chainId: string;
    authPayload: AuthPayload;
    transaction: T;
  }): Promise<T> {
    const [transaction] = await this.redactTransactions({
      chainId: args.chainId,
      authPayload: args.authPayload,
      transactions: [args.transaction],
    });
    return transaction;
  }

  private isMultisigTransaction(
    transaction: object,
  ): transaction is MultisigTransaction {
    return (
      'safeTxHash' in transaction && 'confirmationsRequired' in transaction
    );
  }

  // Same shape as a Transaction Service redacted row: `isExecuted` absent, calldata and signatures null
  private redact<T extends MultisigTransaction>(transaction: T): T {
    return {
      ...transaction,
      isExecuted: undefined,
      data: null,
      origin: null,
      signatures: null,
      confirmations:
        transaction.confirmations?.map((confirmation) => {
          return { ...confirmation, signature: null };
        }) ?? null,
    };
  }
}
