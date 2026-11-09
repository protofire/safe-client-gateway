import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import type { ActivityEventType } from '@/modules/org/activity/activity-event-types';
import { Clock, type IClock } from '@/modules/org/common/clock';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';

/** The `security.*` subset of the activity event types (one list). */
export type SecurityEventType = Extract<
  ActivityEventType,
  `security.${string}`
>;

/**
 * User-scoped security events (`user_security_events`, amendment A3); the IP
 * is stored encrypted. Task 8 fans them out to the user's orgs.
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
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO user_security_events (user_id, type, payload, ip_encrypted, user_agent, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        userId,
        type,
        payload,
        ip ? this.encryption.encrypt(ip) : null,
        userAgent ?? null,
        this.clock.now(),
      ],
    );
  }
}
