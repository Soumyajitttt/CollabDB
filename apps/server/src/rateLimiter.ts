/** Tiny token bucket. `consume(key)` returns false when the key is over its limit. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; last: number }>();

  constructor(private burst: number, private perSec: number, private now: () => number = Date.now) {}

  consume(key: string, cost = 1): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.burst, last: t };
    b.tokens = Math.min(this.burst, b.tokens + ((t - b.last) / 1000) * this.perSec);
    b.last = t;
    const ok = b.tokens >= cost;
    if (ok) b.tokens -= cost;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.sweep(t);
    return ok;
  }

  forget(key: string) {
    this.buckets.delete(key);
  }

  private sweep(t: number) {
    for (const [k, b] of this.buckets) if (t - b.last > 60_000) this.buckets.delete(k);
  }
}
