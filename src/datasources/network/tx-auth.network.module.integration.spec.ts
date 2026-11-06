import { Global, Module, type INestApplication } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import type { Server } from 'net';
import request from 'supertest';
import { faker } from '@faker-js/faker';
import { getAddress } from 'viem';
import { TestAppProvider } from '@/__tests__/test-app.provider';
import { createBaseTestModule } from '@/__tests__/testing-module';
import configuration from '@/config/entities/__tests__/configuration';
import { BlocklistModule } from '@/config/entities/blocklist.module';
import { TestBlocklistModule } from '@/config/entities/__tests__/test.blocklist.module';
import { CacheModule } from '@/datasources/cache/cache.module';
import { TestCacheModule } from '@/datasources/cache/__tests__/test.cache.module';
import { FetchNetworkService } from '@/datasources/network/fetch.network.service';
import {
  FetchClientToken,
  NetworkModule,
} from '@/datasources/network/network.module';
import { NetworkService } from '@/datasources/network/network.service.interface';
import { TxAuthCacheFirstDataSource } from '@/datasources/network/tx-auth.network.module';
import { RequestScopedLoggingModule } from '@/logging/logging.module';
import { TestLoggingModule } from '@/logging/__tests__/test.logging.module';
import {
  type ILoggingService,
  LoggingService,
} from '@/logging/logging.interface';
import { IPricesApi } from '@/modules/balances/datasources/prices-api.interface';
import { IZerionBalancesApi } from '@/modules/balances/datasources/zerion-balances-api.service';
import { IZerionWalletPortfolioApi } from '@/modules/balances/datasources/zerion-wallet-portfolio-api.service';
import { chainBuilder } from '@/modules/chains/domain/entities/__tests__/chain.builder';
import { safeBuilder } from '@/modules/safe/domain/entities/__tests__/safe.builder';
import { rawify } from '@/validation/entities/raw.entity';

const fetchClient = jest.fn();

// Real FetchNetworkService instances over a mocked HTTP client, so that the headers each
// service adds can be asserted per host. The TxAuthNetworkModule is not overridden.
@Global()
@Module({
  providers: [
    { provide: FetchClientToken, useValue: fetchClient },
    {
      provide: NetworkService,
      useFactory: (loggingService: ILoggingService): FetchNetworkService => {
        return new FetchNetworkService(fetchClient, loggingService);
      },
      inject: [LoggingService],
    },
  ],
  exports: [NetworkService, FetchClientToken],
})
class FetchClientMockNetworkModule {}

describe.each([false, true])(
  'TxAuthNetworkModule (useVpcUrl: %s)',
  (useVpcUrl) => {
    let app: INestApplication<Server>;
    let moduleFixture: TestingModule;
    const defaultConfiguration = configuration();
    const testConfiguration = (): typeof defaultConfiguration => ({
      ...defaultConfiguration,
      safeTransaction: {
        ...defaultConfiguration.safeTransaction,
        useVpcUrl,
      },
      features: {
        ...defaultConfiguration.features,
        counterfactualBalances: true,
      },
    });
    const txApiKey = defaultConfiguration.safeTransaction.apiKey;
    const safeConfigUrl = defaultConfiguration.safeConfig.baseUri;
    const pricesProviderUrl =
      defaultConfiguration.balances.providers.safe.prices.baseUri;

    beforeEach(async () => {
      jest.resetAllMocks();
      moduleFixture = await createBaseTestModule({
        config: testConfiguration,
        modules: [
          { originalModule: BlocklistModule, testModule: TestBlocklistModule },
          { originalModule: CacheModule, testModule: TestCacheModule },
          {
            originalModule: RequestScopedLoggingModule,
            testModule: TestLoggingModule,
          },
          {
            originalModule: NetworkModule,
            testModule: FetchClientMockNetworkModule,
          },
        ],
      });
      app = await new TestAppProvider().provide(moduleFixture);
      await app.init();
    });

    afterEach(async () => {
      await app.close();
    });

    it('sends the TX Service API key to the Transaction Service only', async () => {
      const chain = chainBuilder().build();
      const txServiceUrl = useVpcUrl
        ? chain.vpcTransactionService
        : chain.transactionService;
      const safeAddress = getAddress(faker.finance.ethereumAddress());
      const tokenAddress = getAddress(faker.finance.ethereumAddress());
      const currency = faker.finance.currencyCode();
      fetchClient.mockImplementation((url: string) => {
        switch (url.split('?')[0]) {
          case `${safeConfigUrl}/api/v1/chains/${chain.chainId}`:
            return Promise.resolve({ data: rawify(chain), status: 200 });
          case `${txServiceUrl}/api/v1/safes/${safeAddress}`:
            return Promise.resolve({
              data: rawify(safeBuilder().with('address', safeAddress).build()),
              status: 200,
            });
          case `${txServiceUrl}/api/v1/safes/${safeAddress}/balances/`:
            return Promise.resolve({
              data: rawify([
                {
                  tokenAddress,
                  token: {
                    name: faker.finance.currencyName(),
                    symbol: faker.finance.currencySymbol(),
                    decimals: 18,
                    logoUri: faker.internet.url(),
                  },
                  balance: '1000000000000000000',
                },
              ]),
              status: 200,
            });
          default:
            if (url.startsWith(pricesProviderUrl)) {
              return Promise.resolve({ data: rawify({}), status: 200 });
            }
            return Promise.reject(new Error(`Could not match ${url}`));
        }
      });

      await request(app.getHttpServer())
        .get(
          `/v1/chains/${chain.chainId}/safes/${safeAddress}/balances/${currency}`,
        )
        .expect(200);

      const calls = fetchClient.mock.calls.map(
        ([url, init]: [string, RequestInit]) => ({
          url,
          authorization: (init.headers as Record<string, string> | undefined)
            ?.Authorization,
        }),
      );
      const txServiceCalls = calls.filter(({ url }) => {
        return url.startsWith(txServiceUrl);
      });
      const otherCalls = calls.filter(({ url }) => {
        return !url.startsWith(txServiceUrl);
      });
      expect(txServiceCalls.length).toBeGreaterThanOrEqual(2);
      expect(
        otherCalls.some(({ url }) => url.startsWith(pricesProviderUrl)),
      ).toBe(true);
      for (const call of txServiceCalls) {
        expect(call.authorization).toBe(`Bearer ${txApiKey}`);
      }
      for (const call of otherCalls) {
        expect(call.authorization).toBeUndefined();
      }
    });

    it('injects the global NetworkService into third-party balances APIs', () => {
      const networkService = moduleFixture.get(NetworkService);
      for (const token of [
        IPricesApi,
        IZerionBalancesApi,
        IZerionWalletPortfolioApi,
      ]) {
        const api = moduleFixture.get<{ networkService: unknown }>(token, {
          strict: false,
        });
        expect(api.networkService).toBe(networkService);
      }
      const pricesApi = moduleFixture.get<{ dataSource: unknown }>(IPricesApi, {
        strict: false,
      });
      expect(pricesApi.dataSource).not.toBe(
        moduleFixture.get(TxAuthCacheFirstDataSource, { strict: false }),
      );
    });
  },
);
