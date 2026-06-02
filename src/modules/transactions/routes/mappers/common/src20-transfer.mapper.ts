import { Inject, Injectable } from '@nestjs/common';
import { decodeAbiParameters, getAddress } from 'viem';
import type { Address } from 'viem';
import { ModuleTransaction } from '@/modules/safe/domain/entities/module-transaction.entity';
import { MultisigTransaction } from '@/modules/safe/domain/entities/multisig-transaction.entity';
import { Src20Token } from '@/modules/tokens/domain/entities/token.entity';
import { AddressInfoHelper } from '@/routes/common/address-info/address-info.helper';
import { TransferTransactionInfo } from '@/modules/transactions/routes/entities/transfer-transaction-info.entity';
import { Src20Transfer } from '@/modules/transactions/routes/entities/transfers/src20-transfer.entity';
import { getTransferDirection } from '@/modules/transactions/routes/mappers/common/transfer-direction.helper';
import { LoggingService, ILoggingService } from '@/logging/logging.interface';

@Injectable()
export class Src20TransferMapper {
  constructor(
    private readonly addressInfoHelper: AddressInfoHelper,
    @Inject(LoggingService) private readonly loggingService: ILoggingService,
  ) {}

  /**
   * Maps an outgoing SRC20 confidential transfer executed by the Safe.
   *
   * The call is `transfer(address,suint256)`: the recipient is a plaintext `address`, but
   * the amount is a shielded `suint256` that the Transaction Service cannot decode
   * (`dataDecoded` is null). The recipient is therefore read directly from the first
   * argument of the raw call data. The amount is encrypted on-chain, so the value is
   * always reported as "0".
   */
  async mapSrc20Transfer(
    token: Src20Token,
    chainId: string,
    transaction: MultisigTransaction | ModuleTransaction,
    humanDescription: string | null,
  ): Promise<TransferTransactionInfo> {
    const sender = transaction.safe;
    const parsedRecipient = this.getRecipientFromData(transaction.data);
    if (!parsedRecipient) {
      this.loggingService.warn(
        `Could not decode SRC20 transfer recipient; defaulting to the Safe. txHash=${transaction.transactionHash}`,
      );
    }
    const recipient = parsedRecipient ?? sender;
    const direction = getTransferDirection(transaction.safe, sender, recipient);

    const senderAddressInfo = await this.addressInfoHelper.getOrDefault(
      chainId,
      getAddress(sender),
      ['TOKEN', 'CONTRACT'],
    );
    const recipientAddressInfo = await this.addressInfoHelper.getOrDefault(
      chainId,
      getAddress(recipient),
      ['TOKEN', 'CONTRACT'],
    );

    return new TransferTransactionInfo(
      senderAddressInfo,
      recipientAddressInfo,
      direction,
      new Src20Transfer(
        token.address,
        token.name,
        token.symbol,
        token.logoUri,
        token.decimals,
        token.trusted,
      ),
      humanDescription,
    );
  }

  /**
   * The recipient is the first ABI-encoded argument of `transfer(address,suint256)` — the
   * 32-byte word immediately after the 4-byte selector. Decoded via viem's
   * `decodeAbiParameters` so there is a single calldata-decoding path to maintain.
   * Layout: data = 0x | selector(8 hex) | recipient word(64 hex).
   */
  private getRecipientFromData(data: string | null): Address | null {
    if (!data || data.length < 74) {
      return null;
    }
    try {
      const [recipient] = decodeAbiParameters(
        [{ type: 'address' }],
        `0x${data.slice(10, 74)}`,
      );
      return getAddress(recipient);
    } catch {
      return null;
    }
  }
}
