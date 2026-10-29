import { DataSourceError } from '@/domain/errors/data-source.error';

/**
 * A failure of the relay submission request itself (not of lookups before it).
 * With a 5xx or no code the relayer may still have accepted the transaction.
 */
export class RelaySubmitError extends DataSourceError {
  constructor(source: DataSourceError) {
    super(source.message, source.code);
  }
}
