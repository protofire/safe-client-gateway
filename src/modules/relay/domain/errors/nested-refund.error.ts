import { UnprocessableEntityException } from '@nestjs/common';

export class NestedRefundError extends UnprocessableEntityException {
  constructor() {
    super(
      'A transaction that refunds the executor must be relayed on its own, not inside a batch.',
    );
  }
}
