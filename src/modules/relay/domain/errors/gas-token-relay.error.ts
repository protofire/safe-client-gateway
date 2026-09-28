import { HttpException, HttpStatus } from '@nestjs/common';

export type GasTokenRelayErrorCode = 'SIMULATION_FAILED';

/**
 * A Safe-pays relay was refused before reaching the relayer.
 * `code` is stable for the web app to branch on; `message` is informational.
 */
export class GasTokenRelayError extends HttpException {
  constructor(message: string, code?: GasTokenRelayErrorCode) {
    super(
      {
        ...(code && { code }),
        message,
        statusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      },
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  }
}
