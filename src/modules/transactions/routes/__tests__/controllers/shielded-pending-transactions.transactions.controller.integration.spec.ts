import { faker } from '@faker-js/faker';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Server } from 'net';
import { getAddress, zeroAddress, type Address, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import type { PrivateKeyAccount } from 'viem/accounts';
import { TestAppProvider } from '@/__tests__/test-app.provider';
import { createTestModule } from '@/__tests__/testing-module';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { IJwtService } from '@/datasources/jwt/jwt.service.interface';
import type { INetworkService } from '@/datasources/network/network.service.interface';
import { NetworkService } from '@/datasources/network/network.service.interface';
import { NetworkResponseError } from '@/datasources/network/entities/network.error.entity';
import { pageBuilder } from '@/domain/entities/__tests__/page.builder';
import {
  type ILoggingService,
  LoggingService,
} from '@/logging/logging.interface';
import type { Chain } from '@/modules/chains/domain/entities/chain.entity';
import { chainBuilder } from '@/modules/chains/domain/entities/__tests__/chain.builder';
import {
  multisigTransactionBuilder,
  toJson as multisigToJson,
} from '@/modules/safe/domain/entities/__tests__/multisig-transaction.builder';
import type { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import { Operation } from '@/modules/safe/domain/entities/operation.entity';
import type { Safe } from '@/modules/safe/domain/entities/safe.entity';
import { safeBuilder } from '@/modules/safe/domain/entities/__tests__/safe.builder';
import { addConfirmationDtoBuilder } from '@/modules/transactions/routes/__tests__/entities/add-confirmation.dto.builder';
import { proposeTransactionDtoBuilder } from '@/modules/transactions/routes/entities/__tests__/propose-transaction.dto.builder';
import { rawify } from '@/validation/entities/raw.entity';

describe('Shielded pending transactions - Transactions Controller', () => {
  let app: INestApplication<Server>;
  let safeConfigUrl: string;
  let networkService: jest.MockedObjectDeep<INetworkService>;
  let loggingService: jest.MockedObjectDeep<ILoggingService>;
  let jwtService: IJwtService;

  let chain: Chain;
  let owner: PrivateKeyAccount;
  let safe: Safe;
  let pendingTx: MultisigTransaction;
  let executedTx: MultisigTransaction;
  let transactionServicePage: Array<unknown>;

  beforeEach(async () => {
    jest.resetAllMocks();

    const moduleFixture = await createTestModule();
    safeConfigUrl = moduleFixture
      .get<IConfigurationService>(IConfigurationService)
      .getOrThrow('safeConfig.baseUri');
    networkService = moduleFixture.get(NetworkService);
    loggingService = moduleFixture.get(LoggingService);
    jwtService = moduleFixture.get<IJwtService>(IJwtService);
    jest.spyOn(loggingService, 'info');

    app = await new TestAppProvider().provide(moduleFixture);
    await app.init();

    await setUp({ chainId: '5124', features: [] });
  });

  afterEach(async () => {
    await app.close();
  });

  async function setUp(args: {
    chainId: string;
    features: Array<string>;
  }): Promise<void> {
    chain = chainBuilder()
      .with('chainId', args.chainId)
      .with('features', args.features)
      .build();
    owner = privateKeyToAccount(generatePrivateKey());
    safe = safeBuilder()
      .with('owners', [owner.address])
      .with('threshold', 2)
      .with('nonce', 0)
      .build();
    pendingTx = await multisigTransactionBuilder()
      .with('safe', safe.address)
      .with('operation', Operation.CALL)
      .with('value', '0')
      // SRC20 transfer calldata: selector | recipient | amount
      .with(
        'data',
        `0xb10c99b5${faker.string.hexadecimal({ length: 128, casing: 'lower', prefix: '' })}` as Hex,
      )
      .with('nonce', 3)
      .with('gasToken', null)
      .with('isExecuted', false)
      .with('executionDate', null)
      .with('origin', JSON.stringify({ note: 'pay 1000 tokens' }))
      .buildWithConfirmations({
        chainId: chain.chainId,
        safe,
        signers: [owner],
      });
    executedTx = multisigTransactionBuilder()
      .with('safe', safe.address)
      .with('operation', Operation.CALL)
      .with('data', faker.string.hexadecimal({ length: 72 }) as Hex)
      .with('nonce', 0)
      .with('gasToken', null)
      .with('isExecuted', true)
      .with('isSuccessful', true)
      .with('origin', null)
      .with('executionDate', faker.date.recent())
      .build();
    transactionServicePage = [
      multisigToJson(pendingTx),
      multisigToJson(executedTx),
    ];
    mockNetwork();
  }

  function mockNetwork(): void {
    networkService.get.mockImplementation(({ url }) => {
      switch (url) {
        case `${safeConfigUrl}/api/v1/chains/${chain.chainId}`:
          return Promise.resolve({ data: rawify(chain), status: 200 });
        case `${chain.transactionService}/api/v1/safes/${safe.address}`:
          return Promise.resolve({ data: rawify(safe), status: 200 });
        case `${chain.transactionService}/api/v2/multisig-transactions/${pendingTx.safeTxHash}/`:
          return Promise.resolve({
            data: rawify(multisigToJson(pendingTx)),
            status: 200,
          });
        case `${chain.transactionService}/api/v2/safes/${safe.address}/multisig-transactions/`:
          return Promise.resolve({
            data: rawify(
              pageBuilder()
                .with('results', transactionServicePage)
                .with('next', null)
                .with('previous', null)
                .build(),
            ),
            status: 200,
          });
        default:
          return Promise.reject(
            new NetworkResponseError(new URL(url), {
              status: 404,
            } as Response),
          );
      }
    });
    networkService.post.mockImplementation(({ url }) => {
      return Promise.reject(
        new NetworkResponseError(new URL(url), { status: 404 } as Response),
      );
    });
  }

  function cookie(args?: {
    chainId?: string;
    signer?: Address;
    exp?: Date;
  }): Array<string> {
    const accessToken = jwtService.sign({
      chain_id: args?.chainId ?? chain.chainId,
      signer_address: args?.signer ?? owner.address,
      ...(args?.exp && { exp: args.exp }),
    });
    return [`access_token=${accessToken}`];
  }

  function getMultisigTxCalls(): number {
    return networkService.get.mock.calls.filter(([{ url }]) => {
      return (
        url ===
        `${chain.transactionService}/api/v2/multisig-transactions/${pendingTx.safeTxHash}/`
      );
    }).length;
  }

  function expectRedactedDetails(body: unknown): void {
    expect(body).toMatchObject({
      redacted: true,
      txStatus: 'AWAITING_CONFIRMATIONS',
      txData: {
        hexData: null,
        dataDecoded: null,
        addressInfoIndex: null,
        tokenInfoIndex: null,
      },
      note: null,
      safeAppInfo: null,
      detailedExecutionInfo: {
        confirmations: [expect.objectContaining({ signature: null })],
      },
    });
    expect(JSON.stringify(body)).not.toContain(pendingTx.data!.slice(10));
    expect(JSON.stringify(body)).not.toContain('pay 1000 tokens');
  }

  function expectFullDetails(body: unknown): void {
    expect(body).not.toHaveProperty('redacted');
    expect(body).toMatchObject({
      txData: { hexData: pendingTx.data },
      detailedExecutionInfo: {
        confirmations: [
          expect.objectContaining({
            signature: pendingTx.confirmations![0].signature,
          }),
        ],
      },
    });
  }

  describe('GET /v1/chains/:chainId/transactions/:id', () => {
    it.each([
      ['bare safeTxHash', (): string => pendingTx.safeTxHash],
      [
        'multisig_<safe>_<safeTxHash>',
        (): string => `multisig_${safe.address}_${pendingTx.safeTxHash}`,
      ],
    ])('redacts for an anonymous caller (%s id)', async (_, id) => {
      await request(app.getHttpServer())
        .get(`/v1/chains/${chain.chainId}/transactions/${id()}`)
        .expect(200)
        .expect('Cache-Control', 'private, no-store')
        .expect('Vary', /Cookie/)
        .expect(({ body }) => expectRedactedDetails(body));
    });

    it('does not serve a pending multisig transaction through a module_<safe>_<id> id', async () => {
      await request(app.getHttpServer())
        .get(
          `/v1/chains/${chain.chainId}/transactions/module_${safe.address}_${pendingTx.safeTxHash}`,
        )
        .expect(({ text }) => {
          expect(text).not.toContain(pendingTx.data!.slice(10));
        });
    });

    it('returns the full transaction to a current owner', async () => {
      await request(app.getHttpServer())
        .get(`/v1/chains/${chain.chainId}/transactions/${pendingTx.safeTxHash}`)
        .set('Cookie', cookie())
        .expect(200)
        .expect('Cache-Control', 'private, no-store')
        .expect(({ body }) => expectFullDetails(body));
    });

    it('redacts for a signer who is not an owner', async () => {
      await request(app.getHttpServer())
        .get(`/v1/chains/${chain.chainId}/transactions/${pendingTx.safeTxHash}`)
        .set(
          'Cookie',
          cookie({ signer: getAddress(faker.finance.ethereumAddress()) }),
        )
        .expect(200)
        .expect(({ body }) => expectRedactedDetails(body));
    });

    it('redacts for an owner whose session is for another chain', async () => {
      await request(app.getHttpServer())
        .get(`/v1/chains/${chain.chainId}/transactions/${pendingTx.safeTxHash}`)
        .set('Cookie', cookie({ chainId: '1' }))
        .expect(200)
        .expect(({ body }) => expectRedactedDetails(body));
    });

    it('redacts, and does not reject, for an owner with an expired session', async () => {
      await request(app.getHttpServer())
        .get(`/v1/chains/${chain.chainId}/transactions/${pendingTx.safeTxHash}`)
        .set('Cookie', cookie({ exp: new Date(Date.now() - 60_000) }))
        .expect(200)
        .expect(({ body }) => expectRedactedDetails(body));
    });

    it('redacts, and does not reject, for a malformed session cookie', async () => {
      await request(app.getHttpServer())
        .get(`/v1/chains/${chain.chainId}/transactions/${pendingTx.safeTxHash}`)
        .set('Cookie', [`access_token=${faker.string.alphanumeric(20)}`])
        .expect(200)
        .expect(({ body }) => expectRedactedDetails(body));
    });

    it('does not leak through the cache: owner then anonymous', async () => {
      const url = `/v1/chains/${chain.chainId}/transactions/${pendingTx.safeTxHash}`;

      await request(app.getHttpServer())
        .get(url)
        .set('Cookie', cookie())
        .expect(200)
        .expect(({ body }) => expectFullDetails(body));
      await request(app.getHttpServer())
        .get(url)
        .expect(200)
        .expect(({ body }) => expectRedactedDetails(body));

      expect(getMultisigTxCalls()).toBe(1);
    });

    it('does not leak through the cache: anonymous then owner', async () => {
      const url = `/v1/chains/${chain.chainId}/transactions/${pendingTx.safeTxHash}`;

      await request(app.getHttpServer())
        .get(url)
        .expect(200)
        .expect(({ body }) => expectRedactedDetails(body));
      await request(app.getHttpServer())
        .get(url)
        .set('Cookie', cookie())
        .expect(200)
        .expect(({ body }) => expectFullDetails(body));

      expect(getMultisigTxCalls()).toBe(1);
    });

    it('redacts on a chain with the SHIELDED_EVM feature', async () => {
      await setUp({
        chainId: faker.string.numeric({ length: 6 }),
        features: ['SHIELDED_EVM'],
      });

      await request(app.getHttpServer())
        .get(`/v1/chains/${chain.chainId}/transactions/${pendingTx.safeTxHash}`)
        .expect(200)
        .expect('Cache-Control', 'private, no-store')
        .expect(({ body }) => expectRedactedDetails(body));
    });

    it('is unchanged on a non-shielded chain', async () => {
      await setUp({
        chainId: faker.string.numeric({ length: 6 }),
        features: [faker.word.sample()],
      });

      await request(app.getHttpServer())
        .get(`/v1/chains/${chain.chainId}/transactions/${pendingTx.safeTxHash}`)
        .expect(200)
        .expect('Cache-Control', 'no-cache')
        .expect(({ body }) => expectFullDetails(body));
    });
  });

  describe('GET /v1/chains/:chainId/multisig-transactions/:safeTxHash/raw', () => {
    it('returns 404 to an anonymous caller', async () => {
      await request(app.getHttpServer())
        .get(
          `/v1/chains/${chain.chainId}/multisig-transactions/${pendingTx.safeTxHash}/raw`,
        )
        .expect(404);
    });

    it('returns the full transaction to a current owner', async () => {
      await request(app.getHttpServer())
        .get(
          `/v1/chains/${chain.chainId}/multisig-transactions/${pendingTx.safeTxHash}/raw`,
        )
        .set('Cookie', cookie())
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            isExecuted: false,
            data: pendingTx.data,
          });
        });
    });
  });

  describe('GET /v1/chains/:chainId/safes/:safeAddress/multisig-transactions/raw', () => {
    const rawListUrl = (): string =>
      `/v1/chains/${chain.chainId}/safes/${safe.address}/multisig-transactions/raw`;

    it('returns the Transaction Service redacted shape to an anonymous caller', async () => {
      await request(app.getHttpServer())
        .get(rawListUrl())
        .expect(200)
        .expect('Cache-Control', 'private, no-store')
        .expect(({ body }) => {
          const [pending, executed] = body.results;
          expect(pending).not.toHaveProperty('isExecuted');
          expect(pending).toMatchObject({
            safeTxHash: pendingTx.safeTxHash,
            data: null,
            origin: null,
            signatures: null,
            confirmations: [expect.objectContaining({ signature: null })],
          });
          expect(executed).toMatchObject({
            isExecuted: true,
            data: executedTx.data,
          });
          // Never `isExecuted` next to redacted `data`
          for (const row of body.results) {
            expect('isExecuted' in row && row.data === null).toBe(false);
          }
        });
    });

    it('returns full rows to a current owner', async () => {
      await request(app.getHttpServer())
        .get(rawListUrl())
        .set('Cookie', cookie())
        .expect(200)
        .expect(({ body }) => {
          expect(body.results[0]).toMatchObject({
            isExecuted: false,
            data: pendingTx.data,
          });
        });
    });

    it('keeps a row redacted by the Transaction Service redacted for an owner', async () => {
      transactionServicePage = [redactedByTransactionService(pendingTx)];

      await request(app.getHttpServer())
        .get(rawListUrl())
        .set('Cookie', cookie())
        .expect(200)
        .expect(({ body }) => {
          expect(body.results[0]).not.toHaveProperty('isExecuted');
          expect(body.results[0].data).toBe(null);
        });
    });
  });

  describe('mapped lists', () => {
    it('redacts pending items of the multisig transactions list', async () => {
      await request(app.getHttpServer())
        .get(
          `/v1/chains/${chain.chainId}/safes/${safe.address}/multisig-transactions`,
        )
        .expect(200)
        .expect('Cache-Control', 'private, no-store')
        .expect(({ body }) => {
          const [pending, executed] = body.results;
          expect(pending.transaction).toMatchObject({
            redacted: true,
            note: null,
          });
          expect(executed.transaction).not.toHaveProperty('redacted');
          expect(JSON.stringify(body)).not.toContain('pay 1000 tokens');
        });
    });

    it('renders a row redacted by the Transaction Service as redacted and not executed', async () => {
      transactionServicePage = [redactedByTransactionService(pendingTx)];

      await request(app.getHttpServer())
        .get(
          `/v1/chains/${chain.chainId}/safes/${safe.address}/multisig-transactions`,
        )
        .set('Cookie', cookie())
        .expect(200)
        .expect(({ body }) => {
          expect(body.results[0].transaction).toMatchObject({
            redacted: true,
            txStatus: 'AWAITING_CONFIRMATIONS',
          });
        });
    });

    it('redacts pending items of the queue', async () => {
      transactionServicePage = [multisigToJson(pendingTx)];

      await request(app.getHttpServer())
        .get(
          `/v1/chains/${chain.chainId}/safes/${safe.address}/transactions/queued`,
        )
        .expect(200)
        .expect('Cache-Control', 'private, no-store')
        .expect(({ body }) => {
          const results = body.results as Array<{
            type: string;
            transaction?: unknown;
          }>;
          const item = results.find(({ type }) => type === 'TRANSACTION');
          expect(item?.transaction).toMatchObject({ redacted: true });
        });
    });
  });

  describe('POST /v1/chains/:chainId/transactions/:safeAddress/propose', () => {
    it('redacts the response for an anonymous caller and does not log calldata', async () => {
      const proposeTransactionDto = proposeTransactionDtoBuilder()
        .with('to', pendingTx.to)
        .with('value', pendingTx.value)
        .with('data', pendingTx.data)
        .with('nonce', pendingTx.nonce.toString())
        .with('operation', pendingTx.operation)
        .with('safeTxGas', pendingTx.safeTxGas!.toString())
        .with('baseGas', pendingTx.baseGas!.toString())
        .with('gasPrice', pendingTx.gasPrice!)
        .with('gasToken', zeroAddress)
        .with('refundReceiver', pendingTx.refundReceiver)
        .with('safeTxHash', pendingTx.safeTxHash)
        .with('sender', owner.address)
        .with('signature', pendingTx.confirmations![0].signature)
        .with('origin', null)
        .build();
      networkService.post.mockImplementation(({ url }) => {
        if (
          url ===
          `${chain.transactionService}/api/v2/safes/${safe.address}/multisig-transactions/`
        ) {
          return Promise.resolve({ data: rawify({}), status: 200 });
        }
        return Promise.reject(
          new NetworkResponseError(new URL(url), { status: 404 } as Response),
        );
      });

      await request(app.getHttpServer())
        .post(
          `/v1/chains/${chain.chainId}/transactions/${safe.address}/propose`,
        )
        .send(proposeTransactionDto)
        .expect(200)
        .expect('Cache-Control', 'private, no-store')
        .expect(({ body }) => expectRedactedDetails(body));

      expect(loggingService.info).toHaveBeenCalledWith({
        safeTxHash: pendingTx.safeTxHash,
        safeAddress: safe.address,
        chainId: chain.chainId,
        type: 'TRANSACTION_PROPOSE',
      });
      expect(JSON.stringify(loggingService.info.mock.calls)).not.toContain(
        pendingTx.data!.slice(10),
      );
    });
  });

  describe('POST /v1/chains/:chainId/transactions/:safeTxHash/confirmations', () => {
    it('redacts the response for an anonymous caller with a valid owner signature', async () => {
      const addConfirmationDto = addConfirmationDtoBuilder()
        .with('signature', pendingTx.confirmations![0].signature!)
        .build();
      networkService.post.mockImplementation(({ url }) => {
        if (
          url ===
          `${chain.transactionService}/api/v1/multisig-transactions/${pendingTx.safeTxHash}/confirmations/`
        ) {
          return Promise.resolve({ data: rawify({}), status: 200 });
        }
        return Promise.reject(
          new NetworkResponseError(new URL(url), { status: 404 } as Response),
        );
      });

      await request(app.getHttpServer())
        .post(
          `/v1/chains/${chain.chainId}/transactions/${pendingTx.safeTxHash}/confirmations`,
        )
        .send(addConfirmationDto)
        .expect(200)
        .expect('Cache-Control', 'private, no-store')
        .expect(({ body }) => expectRedactedDetails(body));
    });
  });

  function redactedByTransactionService(tx: MultisigTransaction): unknown {
    const row = multisigToJson({
      ...tx,
      data: null,
      origin: null,
      signatures: null,
      confirmations:
        tx.confirmations?.map((c) => ({ ...c, signature: null })) ?? null,
    }) as Record<string, unknown>;
    delete row.isExecuted;
    return row;
  }
});
