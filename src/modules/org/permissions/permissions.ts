/**
 * Every permission the org API checks. Roles grant them as data (`roles.permissions`,
 * seeded by migrations/org/0001-org-core.ts and 0006); code checks permissions, never role keys.
 */
export const PERMISSIONS = [
  'org.view',
  'org.update',
  'org.delete',
  'members.view',
  'members.invite',
  'members.remove',
  'roles.assign',
  'factors.reset',
  'safes.view',
  'safes.link',
  'safes.unlink',
  'addressbook.view',
  'addressbook.write',
  'addressbook.request',
  'addressbook.review',
  'activity.view',
  'exports.read',
  'policies.view',
  'policies.write',
  'payouts.view',
  'payouts.prepare',
  'payouts.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];
