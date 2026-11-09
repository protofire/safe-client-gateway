import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IConfigurationService } from '@/config/configuration.service.interface';
import { ORG_DATA_SOURCE } from '@/modules/org/db/org-data-source';
import { OrgTransaction } from '@/modules/org/db/org-transaction';

export { ORG_DATA_SOURCE };

/**
 * The org database, connected with the app login (ORG_DB_APP_*: not the
 * owner, no BYPASSRLS). Never migrates: migrations run only from org-migrate.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      name: ORG_DATA_SOURCE,
      inject: [IConfigurationService],
      useFactory: (config: IConfigurationService) => ({
        // repeated here: TypeOrmCoreModule finds the DataSource to close on
        // shutdown by the name in these options, not the one above
        name: ORG_DATA_SOURCE,
        type: 'postgres',
        host: config.getOrThrow<string>('org.db.host'),
        port: config.getOrThrow<number>('org.db.port'),
        database: config.getOrThrow<string>('org.db.database'),
        username: config.getOrThrow<string>('org.db.app.username'),
        password: config.getOrThrow<string>('org.db.app.password'),
        ssl: config.getOrThrow<boolean>('org.db.ssl'),
        autoLoadEntities: true,
        synchronize: false,
        migrationsRun: false,
      }),
    }),
  ],
  providers: [OrgTransaction],
  exports: [OrgTransaction],
})
export class OrgDatabaseModule {}
