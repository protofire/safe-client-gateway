import { Module } from '@nestjs/common';
import { CsvService } from '@/modules/csv-export/csv-utils/csv.service';
import { ActivityController } from '@/modules/org/activity/activity.controller';
import { ActivityLog } from '@/modules/org/activity/activity-log.service';
import { FieldEncryptionService } from '@/modules/org/crypto/field-encryption.service';

@Module({
  controllers: [ActivityController],
  providers: [ActivityLog, CsvService, FieldEncryptionService],
  exports: [ActivityLog],
})
export class ActivityModule {}
