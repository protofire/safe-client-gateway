import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';

// No reason or address in the message: the ToS reserves refusal without explanation
export class SanctionsScreeningError extends ForbiddenException {
  constructor() {
    super('This transaction cannot be relayed.');
  }
}

export class SanctionsListUnavailableError extends ServiceUnavailableException {
  constructor() {
    super('Relaying is temporarily unavailable.');
  }
}
