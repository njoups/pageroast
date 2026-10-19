/** Time source for detection, cooldowns, quiet hours and escalation; tests inject a fixed clock. */
export interface Clock { now(): Date }
export const CLOCK = Symbol('CLOCK');
export const systemClock: Clock = { now: () => new Date() };
export const fixedClock = (iso: string | Date): Clock & { set(d: string | Date): void; advance(ms: number): void } => {
  let t = new Date(iso).getTime();
  return { now: () => new Date(t), set: (d) => { t = new Date(d).getTime(); }, advance: (ms) => { t += ms; } };
};
