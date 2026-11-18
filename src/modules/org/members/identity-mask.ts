export type MemberIdentity = { kind: 'wallet' | 'email'; value: string };

/** `a***@example.com` (amendment A16). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

/** `0x1234…abcd` (amendment A16). */
export function maskWallet(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function maskIdentity(identity: MemberIdentity): string {
  return identity.kind === 'email'
    ? maskEmail(identity.value)
    : maskWallet(identity.value);
}
