import request from 'supertest';
import configuration from '@/config/entities/__tests__/configuration';
import { TestAppProvider } from '@/__tests__/test-app.provider';
import { IConfigurationService } from '@/config/configuration.service.interface';
import type { INetworkService } from '@/datasources/network/network.service.interface';
import { NetworkService } from '@/datasources/network/network.service.interface';
import type { INestApplication } from '@nestjs/common';
import { faker } from '@faker-js/faker';
import { chainBuilder } from '@/modules/chains/domain/entities/__tests__/chain.builder';
import { safeBuilder } from '@/modules/safe/domain/entities/__tests__/safe.builder';
import { getAddress } from 'viem';
import { execTransactionEncoder } from '@/modules/contracts/domain/__tests__/encoders/safe-encoder.builder';
import { erc20TransferEncoder } from '@/modules/relay/domain/contracts/__tests__/encoders/erc20-encoder.builder';
import {
  multiSendEncoder,
  multiSendTransactionsEncoder,
} from '@/modules/contracts/domain/__tests__/encoders/multi-send-encoder.builder';
import { getMultiSendDeployments } from '@/domain/common/utils/deployments';
import { rawify } from '@/validation/entities/raw.entity';
import { createTestModule } from '@/__tests__/testing-module';
import { getDeploymentVersionsByChainIds } from '@/__tests__/deployments.helper';
import type { Server } from 'net';

const listUrl = 'https://lists.example/sanctioned-evm/latest.json';
const noFeeCampaignChains = Object.keys(
  configuration().relay.noFeeCampaign || {},
);
const supportedChainId = faker.helpers.arrayElement(
  Object.keys(configuration().relay.apiKey).filter(
    (chainId) => !noFeeCampaignChains.includes(chainId),
  ),
);
const multiSendVersion = faker.helpers.arrayElement(
  getDeploymentVersionsByChainIds('MultiSend', [supportedChainId])[
    supportedChainId
  ],
);

describe('Relay controller - sanctions screening', () => {
  let app: INestApplication<Server>;
  let configurationService: jest.MockedObjectDeep<IConfigurationService>;
  let networkService: jest.MockedObjectDeep<INetworkService>;
  let safeConfigUrl: string;
  let relayUrl: string;
  let listed: string;
  let listPayload: unknown;

  beforeEach(() => {
    jest.resetAllMocks();
    listed = faker.finance.ethereumAddress().toLowerCase();
    listPayload = {
      schema: 1,
      sourceSha256: 'a'.repeat(64),
      sourcePublishDate: 'x',
      generatedAt: new Date().toISOString(),
      checkedAt: new Date().toISOString(),
      count: 1,
      addresses: [listed],
    };
  });

  afterEach(async () => {
    await app.close();
  });

  describe('list available', () => {
    beforeEach(async () => {
      // networkService.get is mocked per-test below, but the list URL must
      // resolve before app.init() triggers onModuleInit -> refresh().
      const moduleFixture = await createTestModule({
        config: () => ({
          ...configuration(),
          relay: {
            ...configuration().relay,
            limit: 5,
            sanctions: { listUrl, maxStalenessHours: 48, extraAddresses: [] },
          },
        }),
      });
      configurationService = moduleFixture.get(IConfigurationService);
      safeConfigUrl = configurationService.getOrThrow('safeConfig.baseUri');
      relayUrl = configurationService.getOrThrow('relay.baseUri');
      networkService = moduleFixture.get(NetworkService);
      networkService.get.mockImplementation(({ url }) => {
        if (url === listUrl) {
          return Promise.resolve({ status: 200, data: rawify(listPayload) });
        }
        return Promise.reject(`No matching rule for url: ${url}`);
      });

      app = await new TestAppProvider().provide(moduleFixture);
      await app.init();
    });

    it('relays a clean execTransaction (201)', async () => {
      const chain = chainBuilder().with('chainId', supportedChainId).build();
      const safe = safeBuilder().build();
      const safeAddress = getAddress(safe.address);
      const data = execTransactionEncoder().encode();
      const taskId = faker.string.uuid();

      networkService.get.mockImplementation(({ url }) => {
        switch (url) {
          case listUrl:
            return Promise.resolve({
              status: 200,
              data: rawify(listPayload),
            });
          case `${safeConfigUrl}/api/v1/chains/${chain.chainId}`:
            return Promise.resolve({ data: rawify(chain), status: 200 });
          case `${chain.transactionService}/api/v1/safes/${safeAddress}`:
            return Promise.resolve({ data: rawify(safe), status: 200 });
          default:
            return Promise.reject(`No matching rule for url: ${url}`);
        }
      });
      networkService.post.mockImplementation(({ url }) => {
        switch (url) {
          case `${relayUrl}/relays/v2/sponsored-call`:
            return Promise.resolve({ data: rawify({ taskId }), status: 200 });
          default:
            return Promise.reject(`No matching rule for url: ${url}`);
        }
      });

      await request(app.getHttpServer())
        .post(`/v1/chains/${chain.chainId}/relay`)
        .send({ version: safe.version, to: safeAddress, data })
        .expect(201)
        .expect({ taskId });
    });

    it('refuses with 403 when a recipient is listed, without naming it', async () => {
      const chain = chainBuilder().with('chainId', supportedChainId).build();
      const safe = safeBuilder().build();
      const safeAddress = getAddress(safe.address);
      const data = execTransactionEncoder()
        .with(
          'data',
          erc20TransferEncoder().with('to', getAddress(listed)).encode(),
        )
        .encode();

      networkService.get.mockImplementation(({ url }) => {
        switch (url) {
          case listUrl:
            return Promise.resolve({
              status: 200,
              data: rawify(listPayload),
            });
          case `${safeConfigUrl}/api/v1/chains/${chain.chainId}`:
            return Promise.resolve({ data: rawify(chain), status: 200 });
          case `${chain.transactionService}/api/v1/safes/${safeAddress}`:
            return Promise.resolve({ data: rawify(safe), status: 200 });
          default:
            return Promise.reject(`No matching rule for url: ${url}`);
        }
      });
      networkService.post.mockImplementation(({ url }) => {
        return Promise.reject(`No matching rule for url: ${url}`);
      });

      const res = await request(app.getHttpServer())
        .post(`/v1/chains/${chain.chainId}/relay`)
        .send({ version: safe.version, to: safeAddress, data })
        .expect(403);

      expect(res.body.message).toBe('This transaction cannot be relayed.');
      expect(JSON.stringify(res.body).toLowerCase()).not.toContain(listed);
      expect(networkService.post).not.toHaveBeenCalledWith(
        expect.objectContaining({ url: expect.stringContaining(relayUrl) }),
      );
    });

    it('refuses with 403 when an owner is listed', async () => {
      const chain = chainBuilder().with('chainId', supportedChainId).build();
      const safe = safeBuilder()
        .with('owners', [getAddress(listed)])
        .build();
      const safeAddress = getAddress(safe.address);
      const data = execTransactionEncoder().encode();

      networkService.get.mockImplementation(({ url }) => {
        switch (url) {
          case listUrl:
            return Promise.resolve({
              status: 200,
              data: rawify(listPayload),
            });
          case `${safeConfigUrl}/api/v1/chains/${chain.chainId}`:
            return Promise.resolve({ data: rawify(chain), status: 200 });
          case `${chain.transactionService}/api/v1/safes/${safeAddress}`:
            return Promise.resolve({ data: rawify(safe), status: 200 });
          default:
            return Promise.reject(`No matching rule for url: ${url}`);
        }
      });
      networkService.post.mockImplementation(({ url }) => {
        return Promise.reject(`No matching rule for url: ${url}`);
      });

      const res = await request(app.getHttpServer())
        .post(`/v1/chains/${chain.chainId}/relay`)
        .send({ version: safe.version, to: safeAddress, data })
        .expect(403);

      expect(res.body.message).toBe('This transaction cannot be relayed.');
      expect(networkService.post).not.toHaveBeenCalledWith(
        expect.objectContaining({ url: expect.stringContaining(relayUrl) }),
      );
    });

    it('refuses with 403 when the Safe itself is listed', async () => {
      const chain = chainBuilder().with('chainId', supportedChainId).build();
      const safe = safeBuilder().with('address', getAddress(listed)).build();
      const safeAddress = getAddress(safe.address);
      const data = execTransactionEncoder().encode();

      networkService.get.mockImplementation(({ url }) => {
        switch (url) {
          case listUrl:
            return Promise.resolve({
              status: 200,
              data: rawify(listPayload),
            });
          case `${safeConfigUrl}/api/v1/chains/${chain.chainId}`:
            return Promise.resolve({ data: rawify(chain), status: 200 });
          case `${chain.transactionService}/api/v1/safes/${safeAddress}`:
            return Promise.resolve({ data: rawify(safe), status: 200 });
          default:
            return Promise.reject(`No matching rule for url: ${url}`);
        }
      });
      networkService.post.mockImplementation(({ url }) => {
        return Promise.reject(`No matching rule for url: ${url}`);
      });

      const res = await request(app.getHttpServer())
        .post(`/v1/chains/${chain.chainId}/relay`)
        .send({ version: safe.version, to: safeAddress, data })
        .expect(403);

      expect(res.body.message).toBe('This transaction cannot be relayed.');
      expect(networkService.post).not.toHaveBeenCalledWith(
        expect.objectContaining({ url: expect.stringContaining(relayUrl) }),
      );
    });

    it('answers 422 for a MultiSend containing execTransaction with gasPrice > 0', async () => {
      const chain = chainBuilder().with('chainId', supportedChainId).build();
      const safe = safeBuilder().build();
      const safeAddress = getAddress(safe.address);
      const [multiSendAddress] = getMultiSendDeployments({
        version: multiSendVersion,
        chainId: chain.chainId,
      });
      const transactions = [
        execTransactionEncoder().encode(),
        execTransactionEncoder().with('gasPrice', BigInt(1)).encode(),
      ].map((data) => ({
        operation: 0,
        data,
        to: safeAddress,
        value: BigInt(0),
      }));
      const data = multiSendEncoder()
        .with('transactions', multiSendTransactionsEncoder(transactions))
        .encode();

      networkService.get.mockImplementation(({ url }) => {
        switch (url) {
          case listUrl:
            return Promise.resolve({
              status: 200,
              data: rawify(listPayload),
            });
          case `${safeConfigUrl}/api/v1/chains/${chain.chainId}`:
            return Promise.resolve({ data: rawify(chain), status: 200 });
          case `${chain.transactionService}/api/v1/safes/${safeAddress}`:
            return Promise.resolve({ data: rawify(safe), status: 200 });
          default:
            return Promise.reject(`No matching rule for url: ${url}`);
        }
      });
      networkService.post.mockImplementation(({ url }) => {
        return Promise.reject(`No matching rule for url: ${url}`);
      });

      const res = await request(app.getHttpServer())
        .post(`/v1/chains/${chain.chainId}/relay`)
        .send({ version: multiSendVersion, to: multiSendAddress, data })
        .expect(422);

      expect(res.body.message).toBe(
        'A transaction that refunds the executor must be relayed on its own, not inside a batch.',
      );
    });
  });

  describe('stale list', () => {
    beforeEach(async () => {
      listPayload = {
        ...(listPayload as Record<string, unknown>),
        checkedAt: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString(),
      };

      const moduleFixture = await createTestModule({
        config: () => ({
          ...configuration(),
          relay: {
            ...configuration().relay,
            limit: 5,
            sanctions: { listUrl, maxStalenessHours: 48, extraAddresses: [] },
          },
        }),
      });
      configurationService = moduleFixture.get(IConfigurationService);
      safeConfigUrl = configurationService.getOrThrow('safeConfig.baseUri');
      relayUrl = configurationService.getOrThrow('relay.baseUri');
      networkService = moduleFixture.get(NetworkService);
      networkService.get.mockImplementation(({ url }) => {
        if (url === listUrl) {
          return Promise.resolve({ status: 200, data: rawify(listPayload) });
        }
        return Promise.reject(`No matching rule for url: ${url}`);
      });

      app = await new TestAppProvider().provide(moduleFixture);
      await app.init();
    });

    it('answers 503 when the list is stale', async () => {
      const chain = chainBuilder().with('chainId', supportedChainId).build();
      const safe = safeBuilder().build();
      const safeAddress = getAddress(safe.address);
      const data = execTransactionEncoder().encode();

      networkService.get.mockImplementation(({ url }) => {
        switch (url) {
          case listUrl:
            return Promise.resolve({
              status: 200,
              data: rawify(listPayload),
            });
          case `${safeConfigUrl}/api/v1/chains/${chain.chainId}`:
            return Promise.resolve({ data: rawify(chain), status: 200 });
          case `${chain.transactionService}/api/v1/safes/${safeAddress}`:
            return Promise.resolve({ data: rawify(safe), status: 200 });
          default:
            return Promise.reject(`No matching rule for url: ${url}`);
        }
      });
      networkService.post.mockImplementation(({ url }) => {
        return Promise.reject(`No matching rule for url: ${url}`);
      });

      const res = await request(app.getHttpServer())
        .post(`/v1/chains/${chain.chainId}/relay`)
        .send({ version: safe.version, to: safeAddress, data })
        .expect(503);

      expect(res.body.message).toBe('Relaying is temporarily unavailable.');
      expect(networkService.post).not.toHaveBeenCalledWith(
        expect.objectContaining({ url: expect.stringContaining(relayUrl) }),
      );
    });
  });

  describe('screening disabled', () => {
    beforeEach(async () => {
      const moduleFixture = await createTestModule({
        config: () => ({
          ...configuration(),
          relay: {
            ...configuration().relay,
            limit: 5,
            sanctions: {
              listUrl: undefined,
              maxStalenessHours: 48,
              extraAddresses: [],
            },
          },
        }),
      });
      configurationService = moduleFixture.get(IConfigurationService);
      safeConfigUrl = configurationService.getOrThrow('safeConfig.baseUri');
      relayUrl = configurationService.getOrThrow('relay.baseUri');
      networkService = moduleFixture.get(NetworkService);

      app = await new TestAppProvider().provide(moduleFixture);
      await app.init();
    });

    it('still answers 422 for a MultiSend containing execTransaction with gasPrice > 0', async () => {
      const chain = chainBuilder().with('chainId', supportedChainId).build();
      const safe = safeBuilder().build();
      const safeAddress = getAddress(safe.address);
      const [multiSendAddress] = getMultiSendDeployments({
        version: multiSendVersion,
        chainId: chain.chainId,
      });
      const transactions = [
        execTransactionEncoder().encode(),
        execTransactionEncoder().with('gasPrice', BigInt(1)).encode(),
      ].map((data) => ({
        operation: 0,
        data,
        to: safeAddress,
        value: BigInt(0),
      }));
      const data = multiSendEncoder()
        .with('transactions', multiSendTransactionsEncoder(transactions))
        .encode();

      networkService.get.mockImplementation(({ url }) => {
        switch (url) {
          case `${safeConfigUrl}/api/v1/chains/${chain.chainId}`:
            return Promise.resolve({ data: rawify(chain), status: 200 });
          case `${chain.transactionService}/api/v1/safes/${safeAddress}`:
            return Promise.resolve({ data: rawify(safe), status: 200 });
          default:
            return Promise.reject(`No matching rule for url: ${url}`);
        }
      });
      networkService.post.mockImplementation(({ url }) => {
        return Promise.reject(`No matching rule for url: ${url}`);
      });

      const res = await request(app.getHttpServer())
        .post(`/v1/chains/${chain.chainId}/relay`)
        .send({ version: multiSendVersion, to: multiSendAddress, data })
        .expect(422);

      expect(res.body.message).toBe(
        'A transaction that refunds the executor must be relayed on its own, not inside a batch.',
      );
      expect(networkService.post).not.toHaveBeenCalledWith(
        expect.objectContaining({ url: expect.stringContaining(relayUrl) }),
      );
    });
  });
});
