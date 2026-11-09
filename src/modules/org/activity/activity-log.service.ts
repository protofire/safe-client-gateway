import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { ActivityEventType } from '@/modules/org/activity/activity-event-types';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';

/** Org-scoped only: user-scoped `security.*` events are written by SecurityEvents. */
export type ActivityEvent = {
  orgId: string;
  actorUserId: string | null;
  type: ActivityEventType;
  targetType?: string;
  targetId?: string;
  payload?: Record<string, unknown>;
  ip?: string;
  userAgent?: string;
};

export interface IActivityLog {
  /** Must run on the caller's EntityManager, inside its transaction. */
  record(em: EntityManager, e: ActivityEvent): Promise<void>;
}

@Injectable()
export class ActivityLog implements IActivityLog {
  constructor(private readonly encryption: FieldEncryptionService) {}

  async record(em: EntityManager, e: ActivityEvent): Promise<void> {
    if (!em.queryRunner?.isTransactionActive) {
      throw new Error('ActivityLog.record must run inside a transaction');
    }
    const ip = e.ip === undefined ? null : this.encryption.encrypt(e.ip);
    const payload = JSON.stringify(e.payload ?? {});
    await em.query(
      `INSERT INTO activity_events
         (org_id, actor_user_id, type, target_type, target_id, payload, ip_encrypted, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [
        e.orgId,
        e.actorUserId,
        e.type,
        e.targetType ?? null,
        e.targetId ?? null,
        payload,
        ip,
        e.userAgent ?? null,
      ],
    );
  }
}
