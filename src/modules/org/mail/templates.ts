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

export function inviteTemplate(mail: InviteMail): {
  subject: string;
  text: string;
  html: string;
} {
  // org names are user input: no line breaks in the subject header
  const orgName = mail.orgName.replace(/[\r\n]+/g, ' ');
  return {
    subject: `You are invited to join ${orgName}`,
    text: [
      `${mail.inviterLabel} invited you to the organization "${orgName}".`,
      `Accept the invitation (valid for 7 days): ${mail.acceptUrl}`,
    ].join('\n\n'),
    html: [
      `<p>${escapeHtml(mail.inviterLabel)} invited you to the organization <strong>${escapeHtml(orgName)}</strong>.</p>`,
      `<p><a href="${escapeHtml(mail.acceptUrl)}">Accept the invitation</a> (valid for 7 days).</p>`,
    ].join(''),
  };
}
