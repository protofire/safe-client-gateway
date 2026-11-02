import { Injectable } from '@nestjs/common';
import { LogType } from '@/domain/common/entities/log-type.entity';
import type { ILoggingService } from '@/logging/logging.interface';
import { RequestScopedLoggingService } from '@/logging/logging.service';

const DROPPED_TYPES = new Set<unknown>([
  LogType.CacheHit,
  LogType.CacheMiss,
  LogType.ExternalRequestCacheError,
  LogType.ExternalRequestCacheHit,
  LogType.ExternalRequestCacheMiss,
]);
const LOCATOR_KEYS = new Set(['field', 'key', 'path', 'url']);
const URL_OR_HEX = /https?:\/\/\S+|0x[0-9a-f]{40,}/gi;
const REDACTED = '[redacted]';

function scrub(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.replace(URL_OR_HEX, REDACTED);
  }
  if (Array.isArray(value)) {
    return value.map(scrub);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [scrub(key), scrub(entry)]),
    );
  }
  return value;
}

/**
 * Returns what may be logged of {@link message}, or undefined for nothing.
 *
 * Reused datasources put tool arguments in URLs, paths and cache keys, and
 * tool arguments are never logged. Failed upstream requests stay visible.
 */
export function redact(message: unknown): unknown {
  if (typeof message !== 'object' || message === null) {
    return scrub(message);
  }
  const entry = message as Record<string, unknown>;
  const isRequestStart =
    entry.type === LogType.ExternalRequest && !('request_status' in entry);
  if (DROPPED_TYPES.has(entry.type) || isRequestStart) {
    return undefined;
  }
  return scrub(
    Object.fromEntries(
      Object.entries(entry).filter(([key]) => !LOCATOR_KEYS.has(key)),
    ),
  );
}

@Injectable()
export class McpLoggingService implements ILoggingService {
  constructor(private readonly logger: RequestScopedLoggingService) {}

  info(message: unknown): void {
    this.forward('info', message);
  }

  debug(message: unknown): void {
    this.forward('debug', message);
  }

  error(message: unknown): void {
    this.forward('error', message);
  }

  warn(message: unknown): void {
    this.forward('warn', message);
  }

  private forward(level: keyof ILoggingService, message: unknown): void {
    const allowed = redact(message);
    if (allowed !== undefined) {
      this.logger[level](allowed);
    }
  }
}
