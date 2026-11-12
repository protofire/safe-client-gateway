import {
  inviteTemplate,
  plainName,
  securityNoticeTemplate,
  signInCodeTemplate,
} from '@/modules/org/mail/templates';

describe('mail templates (item 2)', () => {
  it.each([
    ['Acme https://evil.example.com/login', 'Acme'],
    ['Visit www.evil.example.com today', 'Visit today'],
    ['HTTP://EVIL.example.com', ''],
    ['hxxp http: and https', 'hxxp and'],
    ['Line\r\nBreak', 'Line Break'],
    ['Plain Org', 'Plain Org'],
    ['Pay at evil-login.com/acct', 'Pay at evil-login com/acct'],
    ['EVIL-LOGIN.COM', 'EVIL-LOGIN COM'],
    ['a***@example.com', 'a***@example com'],
    ['x'.repeat(100), 'x'.repeat(64)],
  ])('plainName(%p) = %p', (input, expected) => {
    expect(plainName(input, true)).toBe(expected);
  });

  it.each([
    ['пример.рф', 'пример рф'],
    ['é.com', 'é com'],
  ])('neutralises non-ASCII bare domains: %p', (input, expected) => {
    expect(plainName(input, true)).toBe(expected);
  });

  it('keeps a masked email intact in notices while neutralising an org name domain', () => {
    const mail = securityNoticeTemplate({
      kind: 'admin_removed',
      orgName: 'evil-login.com',
      target: 'j***@gmail.com',
    });
    expect(mail.text).toContain('j***@gmail.com');
    expect(mail.text).toContain('evil-login com');
    expect(mail.text).not.toContain('evil-login.com');
    expect(
      inviteTemplate({
        orgName: 'Acme',
        inviterLabel: 'j***@gmail.com',
        acceptUrl: 'https://app.example.com/i#t',
      }).text,
    ).toContain('j***@gmail.com invited you');
  });

  it('cross-org factors_reset notice does not name the acting org', () => {
    const mail = securityNoticeTemplate({
      kind: 'factors_reset',
      orgName: 'ActingOrg',
      target: 'b***@example.com',
      crossOrg: true,
    });
    const all = `${mail.subject}\n${mail.text}\n${mail.html}`;
    expect(all).not.toContain('ActingOrg');
    expect(mail.text).toContain(
      'An administrator of another organization you share with b***@example.com reset their two-factor authentication.',
    );
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

  it('sign-in code mail: the code, no link, a never-ask warning, never the name Safe', () => {
    const mail = signInCodeTemplate('01234567');
    for (const part of [mail.subject, mail.text, mail.html]) {
      expect(part).not.toMatch(/https?:|www\.|href/i);
      expect(part).not.toMatch(/\bSafe\b/);
    }
    expect(mail.subject).not.toContain('01234567');
    expect(mail.text).toContain('01234567');
    expect(mail.html).toContain('<strong>01234567</strong>');
    expect(mail.text).toContain('We never ask for this code');
  });
});
