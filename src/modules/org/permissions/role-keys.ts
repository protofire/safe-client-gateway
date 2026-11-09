/**
 * Keys of the system roles seeded by migrations/org/0001-org-core.ts, for DTO
 * validation only (e.g. role assignment input). Authorization checks
 * permissions (`PermissionResolver`), never these keys.
 */
export const SYSTEM_ROLE_KEYS = ['admin', 'member'] as const;

export type SystemRoleKey = (typeof SYSTEM_ROLE_KEYS)[number];
