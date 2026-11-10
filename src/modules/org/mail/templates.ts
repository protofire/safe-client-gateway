export type InviteMail = {
  orgName: string;
  inviterLabel: string;
  acceptUrl: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export type MailContent = { subject: string; text: string; html: string };

/**
 * Org and inviter names are user input: one line (no header injection), and
 * no URLs or `http`/`www.` fragments, so a name cannot pose as a link in a
 * mail we send (phishing through our domain).
 */
export function plainName(value: string): string {
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/(?:https?:\/\/|www\.)\S*/gi, '')
    .replace(/https?:?|www\./gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function inviteTemplate(mail: InviteMail): MailContent {
  const orgName = plainName(mail.orgName) || 'an organization';
  const inviter = plainName(mail.inviterLabel) || 'An organization admin';
  return {
    subject: `You are invited to join ${orgName}`,
    text: [
      `${inviter} invited you to the organization "${orgName}".`,
      `Accept the invitation (valid for 7 days): ${mail.acceptUrl}`,
    ].join('\n\n'),
    html: [
      `<p>${escapeHtml(inviter)} invited you to the organization <strong>${escapeHtml(orgName)}</strong>.</p>`,
      `<p><a href="${escapeHtml(mail.acceptUrl)}">Accept the invitation</a> (valid for 7 days).</p>`,
    ].join(''),
  };
}

export type SecurityNotice = {
  kind: 'admin_removed' | 'admin_demoted' | 'org_deleted' | 'factors_reset';
  orgName: string;
  /** Masked identity of the affected member; unused for org_deleted. */
  target?: string;
};

/** Security notices carry no links: nothing to click in a mail about an account change. */
export function securityNoticeTemplate(notice: SecurityNotice): MailContent {
  const org = plainName(notice.orgName) || 'your organization';
  const target = plainName(notice.target ?? '') || 'A member';
  const [subject, line] = {
    admin_removed: [
      `An admin was removed from ${org}`,
      `${target} was removed as an admin from the organization "${org}".`,
    ],
    admin_demoted: [
      `An admin role was removed in ${org}`,
      `${target} is no longer an admin of the organization "${org}".`,
    ],
    org_deleted: [
      `${org} was deleted`,
      `The organization "${org}" was deleted. An admin can restore it within 30 days.`,
    ],
    factors_reset: [
      `Two-factor authentication was reset in ${org}`,
      `An admin of the organization "${org}" reset two-factor authentication for ${target}.`,
    ],
  }[notice.kind];
  const advice =
    'If you did not expect this, contact the other admins of the organization.';
  return {
    subject,
    text: [line, advice].join('\n\n'),
    html: `<p>${escapeHtml(line)}</p><p>${advice}</p>`,
  };
}
