import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource, EntityManager } from 'typeorm';
import type { ActivityEventType } from '@/modules/org/activity/activity-event-types';
import { Clock, type IClock } from '@/modules/org/common/clock';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';

/**
 * Identity changes stay in the user's own log: they are not in the org
 * activity log, so not in ACTIVITY_EVENT_TYPES (the UI's activity filter).
 */
const PER_USER_ONLY = [
  'security.signed_in',
  'security.identity_linked',
  'security.identity_removed',
] as const;

/** The `security.*` activity event types plus the per-user-only ones. */
export type SecurityEventType =
  | Extract<ActivityEventType, `security.${string}`>
  | (typeof PER_USER_ONLY)[number];

/**
 * User-scoped security events (`user_security_events`, amendment A3); the IP
 * is stored encrypted. Each event except sign-in is also written to the
 * activity log of every active org where the user is an active member.
 */
@Injectable()
export class SecurityEvents {
  constructor(
    @InjectDataSource(ORG_DATA_SOURCE) private readonly db: DataSource,
    @Inject(Clock) private readonly clock: IClock,
    private readonly encryption: FieldEncryptionService,
  ) {}

  async record(
    userId: string,
    type: SecurityEventType,
    payload: Record<string, unknown> = {},
    ip?: string,
    userAgent?: string | null,
    /** The caller's transaction, so the event commits with the change it records. */
    em: Pick<EntityManager, 'query'> = this.db,
  ): Promise<void> {
    // One statement, so the user event and its copy in every org where the
    // user is an active member commit together. Sign-ins (plan Task 7) and
    // identity changes stay per user; step-up and factor changes fan out.
    await em.query(
      `WITH event AS (
         INSERT INTO user_security_events (user_id, type, payload, ip_encrypted, user_agent, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING user_id, type, payload, ip_encrypted, user_agent, created_at)
       INSERT INTO activity_events (org_id, actor_user_id, type, payload, ip_encrypted, user_agent, created_at)
       SELECT m.org_id, e.user_id, e.type, e.payload, e.ip_encrypted, e.user_agent, e.created_at
       FROM event e
       JOIN members m ON m.user_id = e.user_id AND m.status = 'active'
       JOIN organizations o ON o.id = m.org_id AND o.status = 'active'
       WHERE e.type <> ALL($7::text[])`,
      [
        userId,
        type,
        payload,
        ip ? this.encryption.encrypt(ip) : null,
        userAgent ?? null,
        this.clock.now(),
        PER_USER_ONLY,
      ],
    );
  }
}
