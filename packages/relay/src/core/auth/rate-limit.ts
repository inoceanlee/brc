/** Tiny in-memory login rate limiter: N failures per key -> lock for a window. */
export class LoginLimiter {
  private fails = new Map<string, { count: number; lockedUntil: number; last: number }>();
  private lastCleanup = 0;
  constructor(private readonly maxFails: number, private readonly lockMs: number) {
    if (!Number.isSafeInteger(maxFails) || maxFails <= 0) throw new Error('LoginLimiter requires a positive maxFails.');
    if (!Number.isSafeInteger(lockMs) || lockMs <= 0) throw new Error('LoginLimiter requires a positive lockMs.');
  }

  prune(now = Date.now()): void {
    if (now - this.lastCleanup < 60_000) return;
    this.lastCleanup = now;
    for (const [key, value] of this.fails) if (value.last < now - 2 * this.lockMs) this.fails.delete(key);
  }
  /** Returns seconds remaining if locked, else 0. */
  locked(key: string): number {
    const e = this.fails.get(key);
    if (!e || e.lockedUntil <= Date.now()) return 0;
    return Math.ceil((e.lockedUntil - Date.now()) / 1000);
  }
  fail(key: string): void {
    this.prune();
    const e = this.fails.get(key) ?? { count: 0, lockedUntil: 0, last: 0 };
    e.count++; e.last = Date.now();
    if (e.count >= this.maxFails) { e.lockedUntil = Date.now() + this.lockMs; e.count = 0; }
    this.fails.set(key, e);
  }
  ok(key: string): void { this.fails.delete(key); }
}