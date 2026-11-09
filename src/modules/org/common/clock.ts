/** Injectable time source, so expiry rules are tested without fake timers. */
export const Clock = Symbol('OrgClock');

export interface IClock {
  now(): Date;
}

export const systemClock: IClock = { now: () => new Date() };
