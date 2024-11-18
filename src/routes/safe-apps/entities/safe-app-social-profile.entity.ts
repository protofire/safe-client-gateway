import { ApiProperty } from '@nestjs/swagger';
import { SafeAppSocialProfile as DomainSafeAppSocialProfile } from '@/domain/safe-apps/entities/safe-app-social-profile.entity';
import { SafeAppSocialProfilePlatforms } from '@/domain/safe-apps/entities/schemas/safe-app.schema';

export class SafeAppSocialProfile implements DomainSafeAppSocialProfile {
  @ApiProperty({ enum: SafeAppSocialProfilePlatforms })
  platform!: SafeAppSocialProfilePlatforms;
  @ApiProperty()
  url!: string;
}
