import type { NestExpressApplication } from '@nestjs/platform-express';
import { configureMcpApp } from '@/mcp-main';

describe('configureMcpApp', () => {
  const originalHops = process.env.MCP_TRUST_PROXY_HOPS;
  const app = {
    enableShutdownHooks: jest.fn(),
    set: jest.fn(),
  };

  beforeEach(() => {
    jest.resetAllMocks();
    delete process.env.MCP_TRUST_PROXY_HOPS;
  });

  afterAll(() => {
    if (originalHops === undefined) {
      delete process.env.MCP_TRUST_PROXY_HOPS;
    } else {
      process.env.MCP_TRUST_PROXY_HOPS = originalHops;
    }
  });

  it('trusts one hop by default and enables shutdown hooks', () => {
    configureMcpApp(app as unknown as NestExpressApplication);

    expect(app.set).toHaveBeenCalledWith('trust proxy', 1);
    expect(app.enableShutdownHooks).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['0', 0],
    ['2', 2],
  ])('trusts the configured hop count %s', (value, expected) => {
    process.env.MCP_TRUST_PROXY_HOPS = value;

    configureMcpApp(app as unknown as NestExpressApplication);

    expect(app.set).toHaveBeenCalledWith('trust proxy', expected);
  });

  it.each(['abc', '-1', '1.5', '', 'true', ' 1', '0x1'])(
    'rejects %j',
    (value) => {
      process.env.MCP_TRUST_PROXY_HOPS = value;

      expect(() =>
        configureMcpApp(app as unknown as NestExpressApplication),
      ).toThrow('MCP_TRUST_PROXY_HOPS must be a non-negative integer');
      expect(app.set).not.toHaveBeenCalled();
    },
  );
});
