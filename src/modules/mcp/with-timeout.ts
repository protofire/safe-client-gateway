/**
 * Rejects with {@link message} after {@link ms}. With Redis down the client
 * queues commands offline and they never settle.
 */
export function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
    // A pending timer never keeps the process alive
    timer.unref();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
