import { clientLabel } from '@/modules/mcp/usage/client-label';

describe('clientLabel', () => {
  it.each([
    [{ clientName: 'claude-code' }, 'claude-code'],
    [{ clientName: 'Claude Code' }, 'claude-code'],
    [{ clientName: 'codex-mcp-client' }, 'codex'],
    [{ clientName: 'Cursor' }, 'cursor'],
    [{ userAgent: 'claude-code/2.1 (cli)' }, 'claude-code'],
    [{}, 'other'],
  ])('labels %j as %s', (input, expected) => {
    expect(clientLabel(input)).toBe(expected);
  });

  it('folds unknown names to other, so the field count stays bounded', () => {
    expect(clientLabel({ clientName: 'my-own-agent/9.9' })).toBe('other');
    expect(clientLabel({ userAgent: 'curl/8.0' })).toBe('other');
  });

  it('prefers the client name over the user agent', () => {
    expect(clientLabel({ clientName: 'unknown', userAgent: 'cursor' })).toBe(
      'other',
    );
  });
});
