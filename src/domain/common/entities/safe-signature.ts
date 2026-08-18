import { secp256k1 } from '@noble/curves/secp256k1';
import { memoize } from 'lodash';
import { Address, getAddress, hashMessage, Hex } from 'viem';
import { publicKeyToAddress } from 'viem/utils';
import { SignatureType } from '@/domain/common/entities/signature-type.entity';
import {
  parseSignaturesByType,
  R_OR_S_HEX_LENGTH,
  SIGNATURE_HEX_LENGTH,
  V_HEX_LENGTH,
} from '@/domain/common/utils/signatures';
import { ADDRESS_LENGTH, HEX_PREFIX_LENGTH } from '@/routes/common/constants';
import { Cron, CronExpression } from '@nestjs/schedule';

const ETH_SIGN_V_OFFSET = 4;
const TRON_SIGN_V_OFFSET = 31;
const TRON_CHAIN_IDS = new Set(['728126428', '2494104990', '3448148188']);

export class SafeSignature {
  public signature: Hex;
  public hash: Hex;
  private readonly chainId?: string;

  constructor(args: { signature: Hex; hash: Hex; chainId?: string }) {
    const signatures = parseSignaturesByType(args.signature);

    if (signatures.length !== 1) {
      throw new Error('Concatenated signatures are not supported');
    }

    if (signatures[0] !== args.signature) {
      throw new Error('Invalid signature');
    }

    this.signature = args.signature;
    this.hash = args.hash;
    this.chainId = args.chainId;
  }

  get r(): Hex {
    return `0x${this.signature.slice(HEX_PREFIX_LENGTH, HEX_PREFIX_LENGTH + R_OR_S_HEX_LENGTH)}`;
  }

  get s(): Hex {
    const rOffset = HEX_PREFIX_LENGTH + R_OR_S_HEX_LENGTH;
    return `0x${this.signature.slice(rOffset, rOffset + R_OR_S_HEX_LENGTH)}`;
  }

  get v(): number {
    const vOffset = HEX_PREFIX_LENGTH + SIGNATURE_HEX_LENGTH - V_HEX_LENGTH;
    return parseInt(this.signature.slice(vOffset, vOffset + V_HEX_LENGTH), 16);
  }

  get signatureType(): SignatureType {
    if (this.v === 0) {
      return SignatureType.ContractSignature;
    }
    if (this.v === 1) {
      return SignatureType.ApprovedHash;
    }
    if (this.v > 30) {
      return SignatureType.EthSign;
    }
    return SignatureType.Eoa;
  }

  get owner(): Address {
    return this._owner();
  }

  private _owner = memoize(
    () => {
      try {
        switch (this.signatureType) {
          case SignatureType.ContractSignature:
          case SignatureType.ApprovedHash: {
            return getAddress(`0x${this.r.slice(ADDRESS_LENGTH * -1)}`);
          }
          case SignatureType.EthSign: {
            const isTron =
              this.chainId !== undefined &&
              TRON_CHAIN_IDS.has(this.chainId);

            if (isTron) {
              // Tron signatures: signed raw EIP-712 hash with v + 31 offset
              // Recovery: use raw hash (no Ethereum prefix), subtract TRON_SIGN_V_OFFSET
              const normalizedSignature: Hex = `${this.r}${this.s.slice(HEX_PREFIX_LENGTH)}${(this.v - TRON_SIGN_V_OFFSET).toString(16).padStart(2, '0')}`;
              return recoverAddress({
                hash: this.hash,
                signature: normalizedSignature,
              });
            }

            // Standard EthSign: hash with Ethereum prefix, subtract ETH_SIGN_V_OFFSET
            // @see https://docs.safe.global/advanced/smart-account-signatures#eth_sign-signature
            const normalizedSignature: Hex = `${this.r}${this.s.slice(HEX_PREFIX_LENGTH)}${(this.v - ETH_SIGN_V_OFFSET).toString(16)}`;
            return recoverAddress({
              hash: hashMessage({ raw: this.hash }),
              signature: normalizedSignature,
            });
          }
          case SignatureType.Eoa: {
            return recoverAddress({
              hash: this.hash,
              signature: this.signature,
            });
          }
        }
      } catch {
        throw new Error('Could not recover address');
      }
    },
    () => {
      return this.signature + this.hash;
    },
  );

  @Cron(CronExpression.EVERY_HOUR, {
    disabled: process.env.NODE_ENV === 'test',
  })
  public clearSignatureMemo(): void {
    if (this._owner.cache.clear) {
      this._owner.cache.clear();
    }
  }
}

function recoverAddress(args: { hash: Hex; signature: Hex }): Address {
  const publicKey = recoverPublicKey(args);
  return publicKeyToAddress(publicKey);
}

function recoverPublicKey(args: { hash: Hex; signature: Hex }): Hex {
  const recoveryBit = toRecoveryBit(args.signature);
  const signature = secp256k1.Signature.fromCompact(
    args.signature.substring(HEX_PREFIX_LENGTH, SIGNATURE_HEX_LENGTH),
  ).addRecoveryBit(recoveryBit);

  const publicKey = signature
    .recoverPublicKey(args.hash.substring(HEX_PREFIX_LENGTH))
    .toHex(false);

  return `0x${publicKey}`;
}

function toRecoveryBit(signature: Hex): number {
  const v = parseInt(signature.slice(V_HEX_LENGTH * -1), 16);
  if (v === 0 || v === 1) {
    return v;
  }
  if (v === 27 || v === 28) {
    return v - 27;
  }
  throw new Error('Invalid v value');
}
