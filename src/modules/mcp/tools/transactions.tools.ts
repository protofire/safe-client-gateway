import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import type { IChainsRepository } from '@/modules/chains/domain/chains.repository.interface';
import type { IDataDecoderRepository } from '@/modules/data-decoder/domain/v2/data-decoder.repository.interface';
import {
  defineTool,
  McpToolError,
  READ_ONLY_ANNOTATIONS,
  type McpTool,
} from '@/modules/mcp/tools/define-tool';
import {
  CursorSchema,
  describeTransaction,
  nextCursor,
  pageRequest,
  safeTxHashOf,
  summarizeTransaction,
} from '@/modules/mcp/tools/summaries';
import { Operation } from '@/modules/safe/domain/entities/operation.entity';
import { QueuedItemType } from '@/modules/transactions/routes/entities/queued-item.entity';
import type { TransactionQueuedItem } from '@/modules/transactions/routes/entities/queued-items/transaction-queued-item.entity';
import type { TransactionItem } from '@/modules/transactions/routes/entities/transaction-item.entity';
import { ExecutionDetailsType } from '@/modules/transactions/routes/entities/transaction-details/execution-details.entity';
import type { MultisigExecutionDetails } from '@/modules/transactions/routes/entities/transaction-details/multisig-execution-details.entity';
import type { TransactionDetails } from '@/modules/transactions/routes/entities/transaction-details/transaction-details.entity';
import type { TransactionsService } from '@/modules/transactions/routes/transactions.service';
import { AddressSchema } from '@/validation/entities/schemas/address.schema';
import { HexSchema } from '@/validation/entities/schemas/hex.schema';
import { NumericStringSchema } from '@/validation/entities/schemas/numeric-string.schema';

const chainIdField = NumericStringSchema.describe(
  'Chain id as a decimal string, from list_chains',
);
const safeAddressField = AddressSchema.describe(
  'Address of the multisig account',
);

const listInput = z.object({
  chainId: chainIdField,
  safeAddress: safeAddressField,
  cursor: CursorSchema,
});

function warningsOf(details: TransactionDetails): Array<string> {
  const { txData } = details;
  if (!txData) {
    return [];
  }
  const warnings: Array<string> = [];
  if (txData.operation === Operation.DELEGATE) {
    warnings.push(
      txData.trustedDelegateCallTarget === true && txData.dataDecoded !== null
        ? 'DELEGATECALL to a known trusted contract: the target code runs with the full authority of the account.'
        : 'DELEGATECALL: the target code runs with the full authority of the account and can change its owners or drain it.',
    );
  }
  const hasCalldata = txData.hexData !== null && txData.hexData !== '0x';
  if (hasCalldata && txData.to.name === null) {
    warnings.push(
      'The target is not a known contract: it has no name in the registries, so the call cannot be verified.',
    );
  }
  return warnings;
}

const MAX_HEX_DATA_LENGTH = 2000;
const MAX_DECODED_LENGTH = 4000;
const MAX_BATCH_CALLS = 20;

// Keeps every target of a batch visible when the full decoding is too large
function reduceDecoded(
  dataDecoded: NonNullable<TransactionDetails['txData']>['dataDecoded'],
): { value: unknown; truncated: boolean } {
  if (
    !dataDecoded ||
    JSON.stringify(dataDecoded).length <= MAX_DECODED_LENGTH
  ) {
    return { value: dataDecoded ?? null, truncated: false };
  }
  const inner = dataDecoded.parameters?.find((p) =>
    Array.isArray(p.valueDecoded),
  )?.valueDecoded;
  if (!Array.isArray(inner)) {
    return { value: { method: dataDecoded.method }, truncated: true };
  }
  return {
    value: {
      method: dataDecoded.method,
      calls: inner.slice(0, MAX_BATCH_CALLS).map((call) => ({
        operation: call.operation,
        to: call.to,
        value: call.value,
        method: call.dataDecoded?.method ?? null,
      })),
      totalCalls: inner.length,
    },
    truncated: true,
  };
}

function detailsOf(details: TransactionDetails): Record<string, unknown> {
  const { txData } = details;
  const multisig =
    details.detailedExecutionInfo?.type === ExecutionDetailsType.Multisig
      ? (details.detailedExecutionInfo as MultisigExecutionDetails)
      : null;
  const hexData = txData?.hexData ?? null;
  const hexDataTruncated =
    hexData !== null && hexData.length > MAX_HEX_DATA_LENGTH;
  const decoded = reduceDecoded(txData?.dataDecoded ?? null);
  return {
    id: details.txId,
    safeTxHash: multisig?.safeTxHash ?? safeTxHashOf(details.txId),
    status: details.txStatus,
    txHash: details.txHash,
    executedAt: details.executedAt,
    nonce: multisig?.nonce ?? null,
    description: describeTransaction(details.txInfo),
    to: txData?.to.value ?? null,
    toName: txData?.to.name ?? null,
    value: txData?.value ?? null,
    operation: txData ? Operation[txData.operation] : null,
    hexData: hexDataTruncated ? hexData.slice(0, MAX_HEX_DATA_LENGTH) : hexData,
    hexDataTruncated,
    dataDecoded: decoded.value,
    dataDecodedTruncated: decoded.truncated,
    proposer: multisig?.proposer?.value ?? null,
    proposedByDelegate: multisig?.proposedByDelegate?.value ?? null,
    confirmations:
      multisig?.confirmations.map(({ signer, submittedAt }) => ({
        signer: signer.value,
        submittedAt,
      })) ?? null,
    threshold: multisig?.confirmationsRequired ?? null,
    rejectors: multisig?.rejectors.map(({ value }) => value) ?? null,
    warnings: warningsOf(details),
  };
}

export function transactionsTools(
  transactionsService: Pick<
    TransactionsService,
    'getTransactionQueue' | 'getTransactionHistory' | 'getById'
  >,
  dataDecoderRepository: Pick<IDataDecoderRepository, 'getDecodedData'>,
  chainsRepository: Pick<IChainsRepository, 'getChain'>,
): Array<McpTool> {
  return [
    defineTool({
      name: 'list_queued_transactions',
      title: 'List queued transactions',
      description:
        'Lists the pending transactions of a multisig account, at most 20 per page, each with id, safeTxHash, nonce, a one-line description, confirmations and threshold. Pass next as cursor for the following page. Prerequisite: chainId from list_chains and the account address. Next: get_transaction with an id or safeTxHash for the calldata, signers and warnings; list_proposers for who may propose.',
      inputSchema: listInput,
      annotations: READ_ONLY_ANNOTATIONS,
      useful: true,
      handler: async ({ chainId, safeAddress, cursor }) => {
        const page = await transactionsService.getTransactionQueue({
          chainId,
          safeAddress,
          trusted: true,
          ...pageRequest(cursor),
        });
        return {
          results: page.results
            .filter(
              (item): item is TransactionQueuedItem =>
                item.type === QueuedItemType.Transaction,
            )
            .map(({ transaction }) => summarizeTransaction(transaction)),
          next: nextCursor(page.next),
        };
      },
    }),
    defineTool({
      name: 'list_transaction_history',
      title: 'List transaction history',
      description:
        'Lists the executed transactions and incoming transfers of a multisig account, newest first, at most 20 per page. Incoming transfers have an id but no safeTxHash. Pass next as cursor for the following page. Prerequisite: chainId from list_chains and the account address. Next: get_transaction with an id for the details.',
      inputSchema: listInput,
      annotations: READ_ONLY_ANNOTATIONS,
      useful: true,
      handler: async ({ chainId, safeAddress, cursor }) => {
        const page = await transactionsService.getTransactionHistory({
          chainId,
          safeAddress,
          timezoneOffsetMs: 0,
          onlyTrusted: true,
          showImitations: false,
          ...pageRequest(cursor),
        });
        return {
          results: page.results
            .filter(
              (item): item is TransactionItem => item.type === 'TRANSACTION',
            )
            .map(({ transaction }) => summarizeTransaction(transaction)),
          next: nextCursor(page.next),
        };
      },
    }),
    defineTool({
      name: 'get_transaction',
      title: 'Get transaction',
      description:
        'Reads one transaction of a multisig account: target, value, operation, calldata with its decoded call, proposer, confirmations, threshold and warnings for DELEGATECALL and for calls to unknown contracts. Prerequisite: chainId, plus an id or a bare safeTxHash from list_queued_transactions or list_transaction_history. Next: get_safe to check the threshold and owners, or decode_calldata for other calldata.',
      inputSchema: z.object({
        chainId: chainIdField,
        txId: z
          .string()
          .min(1)
          .max(200)
          .describe('A transaction id, or a bare safeTxHash'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
      useful: true,
      handler: async ({ chainId, txId }) => {
        try {
          return detailsOf(
            await transactionsService.getById({ chainId, txId }),
          );
        } catch (error) {
          if (error instanceof HttpException && error.getStatus() === 400) {
            throw new McpToolError(
              'INVALID_INPUT',
              'Invalid transaction id. Use an id or safeTxHash from list_queued_transactions or list_transaction_history.',
            );
          }
          throw error;
        }
      },
    }),
    defineTool({
      name: 'decode_calldata',
      title: 'Decode calldata',
      description:
        'Decodes calldata sent to a contract into method and parameters, with the decoder accuracy (FULL_MATCH is verified for this contract). Prerequisite: chainId from list_chains, the target contract address and the 0x calldata. Next: get_transaction for a queued transaction that carries this calldata.',
      inputSchema: z.object({
        chainId: chainIdField,
        to: AddressSchema.describe('Address of the contract being called'),
        data: HexSchema.describe('The 0x-prefixed calldata'),
      }),
      annotations: READ_ONLY_ANNOTATIONS,
      useful: true,
      handler: async ({ chainId, to, data }) => {
        // The decoder does not resolve the chain; an unknown one is NOT_FOUND
        await chainsRepository.getChain(chainId);
        const { method, parameters, accuracy } =
          await dataDecoderRepository.getDecodedData({
            chainId,
            to,
            data: data,
          });
        return { method, parameters, accuracy };
      },
    }),
  ];
}
