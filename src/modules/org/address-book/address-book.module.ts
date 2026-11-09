import { Module } from '@nestjs/common';
import { CsvService } from '@/modules/csv-export/csv-utils/csv.service';
import { ActivityModule } from '@/modules/org/activity/activity.module';
import { ContactRequestsService } from '@/modules/org/address-book/contact-requests.service';
import { ContactsController } from '@/modules/org/address-book/contacts.controller';
import { ContactsService } from '@/modules/org/address-book/contacts.service';
import { OrgTransaction } from '@/modules/org/db/org-transaction';

@Module({
  imports: [ActivityModule],
  controllers: [ContactsController],
  providers: [
    ContactsService,
    ContactRequestsService,
    CsvService,
    OrgTransaction,
  ],
})
export class AddressBookModule {}
