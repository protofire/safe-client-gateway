import { SafeAppAccessControlPolicies } from '@/domain/safe-apps/entities/safe-app-access-control.entity';
import { z } from 'zod';

export const SafeAppAccessControlSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal(SafeAppAccessControlPolicies.DomainAllowlist),
    value: z.array(z.string().url()).nullish().default(null),
  }),
  z.object({
    type: z.literal(SafeAppAccessControlPolicies.NoRestrictions),
  }),
  z.object({
    type: z.literal(SafeAppAccessControlPolicies.Unknown),
  }),
]);

export enum SafeAppSocialProfilePlatforms {
  Discord = 'DISCORD',
  GitHub = 'GITHUB',
  Twitter = 'TWITTER',
  Unknown = 'UNKNOWN',
}

export const SafeAppSocialProfileSchema = z.object({
  platform: z
    .nativeEnum(SafeAppSocialProfilePlatforms)
    .catch(SafeAppSocialProfilePlatforms.Unknown),
  url: z.string().url(),
});

export const SafeAppProviderSchema = z.object({
  url: z.string().url(),
  name: z.string(),
});

export const SafeAppSchema = z.object({
  id: z.number(),
  url: z.string().url(),
  name: z.string(),
  description: z.string(),
  chainIds: z.array(z.number()),
  accessControl: SafeAppAccessControlSchema,
  tags: z.array(z.string()),
  features: z.array(z.string()),
  socialProfiles: z.array(SafeAppSocialProfileSchema),
  iconUrl: z.string().url().nullish().default(null),
  provider: SafeAppProviderSchema.nullish().default(null),
  developerWebsite: z.string().url().nullish().default(null),
  featured: z.boolean(),
});

export const SafeAppsSchema = z.array(SafeAppSchema);
