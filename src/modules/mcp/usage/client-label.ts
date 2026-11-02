export type ClientLabel = 'claude-code' | 'codex' | 'cursor' | 'other';

const MAX_NAME_LENGTH = 200;
const KNOWN: Array<[RegExp, ClientLabel]> = [
  [/claude[- ]code/i, 'claude-code'],
  [/codex/i, 'codex'],
  [/cursor/i, 'cursor'],
];

/** Folds a client's self-reported name into a fixed set, so field counts stay bounded. */
export function clientLabel(input: {
  clientName?: string;
  userAgent?: string;
}): ClientLabel {
  const source = (input.clientName ?? input.userAgent ?? '').slice(
    0,
    MAX_NAME_LENGTH,
  );
  return KNOWN.find(([pattern]) => pattern.test(source))?.[1] ?? 'other';
}
