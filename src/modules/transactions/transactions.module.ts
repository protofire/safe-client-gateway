import { Module } from '@nestjs/common';
import { TransactionApiManagerModule } from '@/domain/interfaces/transaction-api.manager.interface';
import { ITransactionsRepository } from '@/modules/transactions/domain/transactions.repository.interface';
import { TransactionsRepository } from '@/modules/transactions/domain/transactions.repository';
import { DataDecoderModule } from '@/modules/data-decoder/data-decoder.module';
import { SafeRepositoryModule } from '@/modules/safe/domain/safe.repository.interface';
import { TokensModule } from '@/modules/tokens/tokens.module';
import { TransactionMappersModule } from '@/modules/transactions/transaction-mappers.module';
import { TransactionsController } from '@/modules/transactions/routes/transactions.controller';
import { TransactionsService } from '@/modules/transactions/routes/transactions.service';

@Module({
  controllers: [TransactionsController],
  imports: [
    DataDecoderModule,
    SafeRepositoryModule,
    TokensModule,
    TransactionApiManagerModule,
    TransactionMappersModule,
  ],
  providers: [
    TransactionsService,
    {
      provide: ITransactionsRepository,
      useClass: TransactionsRepository,
    },
  ],
  exports: [ITransactionsRepository, TransactionsService],
})
export class TransactionsModule {}
