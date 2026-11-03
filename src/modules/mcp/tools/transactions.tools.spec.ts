import { BadRequestException } from '@nestjs/common';
import { getAddress } from 'viem';
import { faker } from '@faker-js/faker';
import { DataSourceError } from '@/domain/errors/data-source.error';
import { callTool } from '@/modules/mcp/tools/__tests__/call-tool';
import { transactionsTools } from '@/modules/mcp/tools/transactions.tools';

describe('transaction tools', () => {
  const service = {
    getTransactionQueue: jest.fn(),
    getTransactionHistory: jest.fn(),
    getById: jest.fn(),
    getCreationTransaction: jest.fn(),
  };
  const decoder = { getDecodedData: jest.fn() };
  const chains = { getChain: jest.fn() };
  const tools = transactionsTools(service, decoder, chains);
  const safeAddress = getAddress(faker.finance.ethereumAddress());
  const hash = `0x${'ab'.repeat(32)}`;
  const args = { chainId: '1', safeAddress };

  const transaction = (id: string, extra: object = {}): object => ({
    id,
    timestamp: 1,
    txStatus: 'AWAITING_CONFIRMATIONS',
    txInfo: {
      type: 'Custom',
      humanDescription: 'Send\n 1 ETH',
      methodName: null,
    },
    executionInfo: {
      type: 'MULTISIG',
      nonce: 7,
      confirmationsRequired: 3,
      confirmationsSubmitted: 1,
      missingSigners: null,
    },
    ...extra,
  });

  beforeEach(() => jest.resetAllMocks());

  describe('list_queued_transactions', () => {
    it('returns <= 20 summaries and a next cursor, dropping labels and conflict headers', async () => {
      service.getTransactionQueue.mockResolvedValue({
        count: 1,
        previous: null,
        next: 'https://mcp.invalid/?cursor=limit%3D20%26offset%3D20',
        results: [
          { type: 'LABEL', label: 'Next' },
          {
            type: 'TRANSACTION',
            conflictType: 'None',
            transaction: transaction(`multisig_${safeAddress}_${hash}`),
          },
          { type: 'CONFLICT_HEADER', nonce: 7 },
        ],
      });

      const { payload } = await callTool(
        tools,
        'list_queued_transactions',
        args,
      );

      expect(payload.results).toEqual([
        {
          id: `multisig_${safeAddress}_${hash}`,
          safeTxHash: hash,
          status: 'AWAITING_CONFIRMATIONS',
          nonce: 7,
          description: 'Send 1 ETH',
          confirmations: 1,
          threshold: 3,
          timestamp: 1,
        },
      ]);
      expect(payload.next).toBe('limit=20&offset=20');
      const call = service.getTransactionQueue.mock.calls[0][0] as {
        paginationData: object;
        routeUrl: URL;
      };
      expect(call.paginationData).toMatchObject({ limit: 20, offset: 0 });
      expect(call.routeUrl.toString()).toBe(
        'https://mcp.invalid/?cursor=limit%3D20%26offset%3D0',
      );
    });

    it('passes the client offset back in, never its limit', async () => {
      service.getTransactionQueue.mockResolvedValue({
        count: 0,
        next: null,
        previous: null,
        results: [],
      });

      const { payload } = await callTool(tools, 'list_queued_transactions', {
        ...args,
        cursor: 'limit=1000&offset=40',
      });

      expect(
        service.getTransactionQueue.mock.calls[0][0].paginationData,
      ).toMatchObject({
        limit: 20,
        offset: 40,
      });
      expect(payload.next).toBeNull();
    });
  });

  describe('list_transaction_history', () => {
    it('includes an incoming transfer: it has id, no safeTxHash', async () => {
      const id = `transfer_${safeAddress}_e1234`;
      service.getTransactionHistory.mockResolvedValue({
        count: 2,
        next: null,
        previous: null,
        results: [
          { type: 'DATE_LABEL', timestamp: 1 },
          {
            type: 'TRANSACTION',
            conflictType: 'None',
            transaction: transaction(id, {
              txStatus: 'SUCCESS',
              executionInfo: null,
            }),
          },
        ],
      });

      const { payload } = await callTool(
        tools,
        'list_transaction_history',
        args,
      );

      expect(payload.results).toHaveLength(1);
      expect(payload.results[0]).toMatchObject({
        id,
        safeTxHash: null,
        nonce: null,
        confirmations: null,
        threshold: null,
      });
      expect(service.getTransactionHistory).toHaveBeenCalledWith(
        expect.objectContaining({
          timezoneOffsetMs: 0,
          onlyTrusted: true,
          showImitations: false,
        }),
      );
    });
  });

  describe('transfer descriptions', () => {
    const sender = getAddress(faker.finance.ethereumAddress());
    const recipient = getAddress(faker.finance.ethereumAddress());
    const transferInfo = (direction: string, transfer: object): object => ({
      type: 'Transfer',
      humanDescription: null,
      sender: { value: sender },
      recipient: { value: recipient },
      direction,
      transferInfo: transfer,
    });

    it('describes an incoming ERC20 transfer in the history', async () => {
      service.getTransactionHistory.mockResolvedValue({
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            type: 'TRANSACTION',
            conflictType: 'None',
            transaction: transaction(`transfer_${safeAddress}_e1`, {
              txStatus: 'SUCCESS',
              executionInfo: null,
              txInfo: transferInfo('INCOMING', {
                type: 'ERC20',
                tokenAddress: recipient,
                value: '1500000',
                tokenSymbol: 'USDC',
                decimals: 6,
              }),
            }),
          },
        ],
      });

      const { payload } = await callTool(
        tools,
        'list_transaction_history',
        args,
      );

      expect(payload.results[0].description).toBe(
        `INCOMING transfer of 1.5 USDC from ${sender}`,
      );
    });

    it('keeps base units when a token amount is not an integer', async () => {
      service.getById.mockResolvedValue({
        txId: `transfer_${safeAddress}_i2`,
        txStatus: 'SUCCESS',
        txHash: hash,
        executedAt: 1,
        txInfo: transferInfo('INCOMING', {
          type: 'ERC20',
          tokenAddress: recipient,
          value: '1.5',
          tokenSymbol: 'USDC',
          decimals: 6,
        }),
        txData: null,
        detailedExecutionInfo: null,
      });

      const { payload } = await callTool(tools, 'get_transaction', {
        chainId: '1',
        txId: `transfer_${safeAddress}_i2`,
      });

      expect(payload.description).toBe(
        `INCOMING transfer of 1.5 base units of USDC from ${sender}`,
      );
    });

    it('describes an outgoing native transfer in get_transaction', async () => {
      service.getById.mockResolvedValue({
        txId: `transfer_${safeAddress}_i1`,
        txStatus: 'SUCCESS',
        txHash: hash,
        executedAt: 1,
        txInfo: transferInfo('OUTGOING', {
          type: 'NATIVE_COIN',
          value: '1000000000000000000',
        }),
        txData: null,
        detailedExecutionInfo: null,
      });

      const { payload } = await callTool(tools, 'get_transaction', {
        chainId: '1',
        txId: `transfer_${safeAddress}_i1`,
      });

      expect(payload.description).toBe(
        `OUTGOING transfer of 1000000000000000000 wei of native coin to ${recipient}`,
      );
    });
  });

  describe('get_transaction', () => {
    const details = (txData: object | null): object => ({
      txId: `multisig_${safeAddress}_${hash}`,
      safeAddress,
      txStatus: 'AWAITING_EXECUTION',
      txHash: null,
      executedAt: null,
      txInfo: { type: 'Custom', humanDescription: null, methodName: 'foo' },
      txData,
      detailedExecutionInfo: {
        type: 'MULTISIG',
        nonce: 7,
        safeTxHash: hash,
        confirmationsRequired: 2,
        confirmations: [
          { signer: { value: safeAddress }, signature: '0x1', submittedAt: 5 },
        ],
        rejectors: [],
        proposer: { value: safeAddress },
        proposedByDelegate: null,
      },
    });
    const data = (extra: object): object => ({
      hexData: '0x1234',
      dataDecoded: null,
      to: { value: safeAddress, name: 'Known' },
      value: '0',
      operation: 0,
      trustedDelegateCallTarget: null,
      ...extra,
    });

    it('caps hexData at 2000 characters and says so', async () => {
      const long = `0x${'ab'.repeat(2000)}`;
      service.getById.mockResolvedValue(details(data({ hexData: long })));

      const { payload } = await callTool(tools, 'get_transaction', {
        chainId: '1',
        txId: hash,
      });

      expect(payload.hexData).toBe(long.slice(0, 2000));
      expect(payload.hexDataTruncated).toBe(true);
    });

    it('leaves short hexData whole', async () => {
      service.getById.mockResolvedValue(details(data({})));

      const { payload } = await callTool(tools, 'get_transaction', {
        chainId: '1',
        txId: hash,
      });

      expect(payload.hexData).toBe('0x1234');
      expect(payload.hexDataTruncated).toBe(false);
    });

    it('accepts a CGW id and a bare safeTxHash', async () => {
      service.getById.mockResolvedValue(details(data({})));
      const id = `multisig_${safeAddress}_${hash}`;

      for (const txId of [id, hash]) {
        const { payload } = await callTool(tools, 'get_transaction', {
          chainId: '1',
          txId,
        });
        expect(payload).toMatchObject({
          safeTxHash: hash,
          nonce: 7,
          threshold: 2,
          proposer: safeAddress,
          description: 'Custom: foo',
        });
        expect(payload.confirmations).toEqual([
          { signer: safeAddress, submittedAt: 5 },
        ]);
        expect(payload.warnings).toEqual([]);
        expect(service.getById).toHaveBeenLastCalledWith({
          chainId: '1',
          txId,
        });
      }
    });

    it('warns on DELEGATECALL and on an unknown contract', async () => {
      service.getById.mockResolvedValue(
        details(data({ operation: 1, to: { value: safeAddress, name: null } })),
      );

      const { payload } = await callTool(tools, 'get_transaction', {
        chainId: '1',
        txId: hash,
      });

      expect(payload.operation).toBe('DELEGATE');
      expect(payload.warnings).toHaveLength(2);
      expect(payload.warnings[0]).toMatch(/DELEGATECALL/);
      expect(payload.warnings[1]).toMatch(/not a known contract/);
    });

    it('does not call a delegatecall trusted when the decoder returned nothing', async () => {
      service.getById.mockResolvedValue(
        details(data({ operation: 1, trustedDelegateCallTarget: true })),
      );

      const { payload } = await callTool(tools, 'get_transaction', {
        chainId: '1',
        txId: hash,
      });

      expect(payload.warnings[0]).toMatch(/can change its owners or drain/);
      expect(payload.warnings[0]).not.toMatch(/trusted/);
    });

    it('reduces a large decoded batch but keeps its targets visible', async () => {
      const calls = Array.from({ length: 40 }, (_, i) => ({
        operation: 0,
        to: getAddress(`0x${(i + 1).toString(16).padStart(40, '0')}`),
        value: '0',
        dataDecoded: { method: 'transfer', parameters: [] },
        data: `0x${'ab'.repeat(200)}`,
      }));
      service.getById.mockResolvedValue(
        details(
          data({
            dataDecoded: {
              method: 'multiSend',
              parameters: [{ name: 'transactions', valueDecoded: calls }],
            },
          }),
        ),
      );

      const { payload } = await callTool(tools, 'get_transaction', {
        chainId: '1',
        txId: hash,
      });

      expect(payload.dataDecodedTruncated).toBe(true);
      expect(payload.dataDecoded.totalCalls).toBe(40);
      expect(payload.dataDecoded.calls).toHaveLength(20);
      expect(payload.dataDecoded.calls[0]).toEqual({
        operation: 0,
        to: calls[0].to,
        value: '0',
        method: 'transfer',
      });
    });

    it('opens a creation id from the history as the creation transaction', async () => {
      const creator = getAddress(faker.finance.ethereumAddress());
      const factory = getAddress(faker.finance.ethereumAddress());
      const singleton = getAddress(faker.finance.ethereumAddress());
      const created = new Date('2026-01-01T00:00:00.000Z');
      service.getCreationTransaction.mockResolvedValue({
        created,
        creator,
        transactionHash: hash,
        factoryAddress: factory,
        masterCopy: singleton,
        setupData: '0x',
        saltNonce: '0',
        dataDecoded: null,
      });
      const txId = `creation_${safeAddress}`;

      const { payload } = await callTool(tools, 'get_transaction', {
        chainId: '1',
        txId,
      });

      expect(service.getCreationTransaction).toHaveBeenCalledWith({
        chainId: '1',
        safeAddress,
      });
      expect(service.getById).not.toHaveBeenCalled();
      expect(payload).toMatchObject({
        id: txId,
        creator,
        transactionHash: hash,
        factory,
        singleton,
        created: created.toISOString(),
      });
    });

    it('rejects an id that is not a transaction id shape, without a request', async () => {
      const { isError, payload } = await callTool(tools, 'get_transaction', {
        chainId: '1',
        txId: '../../v1/safes',
      });

      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
      expect(service.getById).not.toHaveBeenCalled();
    });

    it('maps a malformed id to INVALID_INPUT', async () => {
      service.getById.mockRejectedValue(
        new BadRequestException('Invalid transaction ID'),
      );

      const { isError, payload } = await callTool(tools, 'get_transaction', {
        chainId: '1',
        txId: 'nope',
      });

      expect(isError).toBe(true);
      expect(payload.code).toBe('INVALID_INPUT');
    });
  });

  describe('decode_calldata', () => {
    it('returns the decoded call', async () => {
      decoder.getDecodedData.mockResolvedValue({
        method: 'transfer',
        parameters: [{ name: 'to', type: 'address', value: safeAddress }],
        accuracy: 'FULL_MATCH',
      });

      const { payload } = await callTool(tools, 'decode_calldata', {
        chainId: '1',
        to: safeAddress,
        data: '0xa9059cbb',
      });

      expect(decoder.getDecodedData).toHaveBeenCalledWith({
        chainId: '1',
        to: safeAddress,
        data: '0xa9059cbb',
      });
      expect(payload).toMatchObject({
        method: 'transfer',
        accuracy: 'FULL_MATCH',
      });
    });

    it('reduces a large decoded batch and keeps the accuracy', async () => {
      const calls = Array.from({ length: 40 }, () => ({
        operation: 0,
        to: safeAddress,
        value: '0',
        dataDecoded: { method: 'transfer', parameters: [] },
        data: `0x${'ab'.repeat(200)}`,
      }));
      decoder.getDecodedData.mockResolvedValue({
        method: 'multiSend',
        parameters: [{ name: 'transactions', valueDecoded: calls }],
        accuracy: 'FULL_MATCH',
      });

      const { payload } = await callTool(tools, 'decode_calldata', {
        chainId: '1',
        to: safeAddress,
        data: '0x8d80ff0a',
      });

      expect(payload.truncated).toBe(true);
      expect(payload.accuracy).toBe('FULL_MATCH');
      expect(payload.totalCalls).toBe(40);
      expect(payload.calls).toHaveLength(20);
      expect(payload).not.toHaveProperty('parameters');
    });

    it('is NOT_FOUND for a chain that does not resolve, without decoding', async () => {
      chains.getChain.mockRejectedValue(new DataSourceError('Not found', 404));

      const { isError, payload } = await callTool(tools, 'decode_calldata', {
        chainId: '99999999999',
        to: safeAddress,
        data: '0xa9059cbb',
      });

      expect(isError).toBe(true);
      expect(payload.code).toBe('NOT_FOUND');
      expect(decoder.getDecodedData).not.toHaveBeenCalled();
    });

    it('rejects non-hex calldata', async () => {
      const { payload } = await callTool(tools, 'decode_calldata', {
        chainId: '1',
        to: safeAddress,
        data: 'zz',
      });

      expect(payload.code).toBe('INVALID_INPUT');
    });
  });
});
