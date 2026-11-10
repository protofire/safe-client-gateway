import {
  inviteTemplate,
  plainName,
  securityNoticeTemplate,
} from '@/modules/org/mail/templates';

describe('mail templates (item 2)', () => {
  it.each([
    ['Acme https://evil.example.com/login', 'Acme'],
    ['Visit www.evil.example.com today', 'Visit today'],
    ['HTTP://EVIL.example.com', ''],
    ['hxxp http: and https', 'hxxp and'],
    ['Line\r\nBreak', 'Line Break'],
    ['Plain Org', 'Plain Org'],
  ])('plainName(%p) = %p', (input, expected) => {
    expect(plainName(input)).toBe(expected);
  });

  it('strips links from org and inviter names in invitations, keeps the accept URL', () => {
    const mail = inviteTemplate({
      orgName: 'Acme www.evil.example.com',
      inviterLabel: 'Bob https://evil.example.com',
      acceptUrl: 'https://app.example.com/organizations/invite#token=t',
    });
    const all = `${mail.subject}\n${mail.text}\n${mail.html}`;
    expect(all).not.toContain('evil');
    expect(all).not.toMatch(/www\./);
    expect(mail.text).toContain(
      'https://app.example.com/organizations/invite#token=t',
    );
  });

  it.each([
    'admin_removed',
    'admin_demoted',
    'org_deleted',
    'factors_reset',
  ] as const)(
    '%s notice carries no link, even with a link-like name',
    (kind) => {
      const mail = securityNoticeTemplate({
        kind,
        orgName: 'Acme <b> https://evil.example.com',
        target: 'b***@example.com www.evil.example.com',
      });
      const all = `${mail.subject}\n${mail.text}\n${mail.html}`;
      expect(all).not.toMatch(/https?:|www\.|evil|href/i);
      expect(mail.html).not.toContain('<b>');
      expect(mail.subject).not.toMatch(/[\r\n]/);
      expect(mail.text).toContain('Acme');
    },
  );
});
