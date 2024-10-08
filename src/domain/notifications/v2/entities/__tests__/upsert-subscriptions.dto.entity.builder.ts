import { faker } from '@faker-js/faker';
import { Builder, IBuilder } from '@/__tests__/builder';
import { getAddress } from 'viem';
import { UpsertSubscriptionsDto } from '@/domain/notifications/v2/entities/upsert-subscriptions.dto.entity';
import { DeviceType } from '@/domain/notifications/v2/entities/device-type.entity';
import { Uuid } from '@/domain/notifications/v2/entities/uuid.entity';
import { NotificationType } from '@/domain/notifications/v2/entities/notification-type.entity';

export function upsertSubscriptionsDtoBuilder(): IBuilder<UpsertSubscriptionsDto> {
  return new Builder<UpsertSubscriptionsDto>()
    .with('cloudMessagingToken', faker.string.alphanumeric({ length: 10 }))
    .with('deviceType', faker.helpers.arrayElement(Object.values(DeviceType)))
    .with('deviceUuid', faker.string.uuid() as Uuid)
    .with(
      'safes',
      Array.from(
        {
          length: faker.number.int({ min: 1, max: 5 }),
        },
        () => {
          return {
            chainId: faker.string.numeric(),
            address: getAddress(faker.finance.ethereumAddress()),
            notificationTypes: faker.helpers.arrayElements(
              Object.values(NotificationType),
            ),
          };
        },
      ),
    );
}
