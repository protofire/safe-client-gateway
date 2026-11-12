/**
 * Keys of the system roles seeded by migrations/org/0001-org-core.ts, for DTO
 * validation only (e.g. role assignment input). Authorization checks
 * permissions (`PermissionResolver`), never these keys.
 */
export const SYSTEM_ROLE_KEYS = ['admin', 'member'] as const;

export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];

/**
 * Invitations always grant this role (Nick, 2026-11-10); promotion is the
 * role-change endpoint, which needs step-up.
 */
export const INVITATION_ROLE_KEY = 'member' satisfies SystemRoleKey;
