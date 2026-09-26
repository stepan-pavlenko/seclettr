export interface RateLimitOptions {
  maxRequests: number;
  windowMs: number;
  /**
   * Upper bound on retained buckets. The map was previously unbounded, so a
   * client cycling keys (IPs / identities) could grow it without limit
   * (see AUDIT.md H13).
   */
  maxBuckets?: number;
  now?: () => number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs: number;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const DEFAULT_MAX_BUCKETS = 100_000;

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxBuckets: number;
  private readonly now: () => number;

  constructor(options: RateLimitOptions) {
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;
    this.maxBuckets = Math.max(options.maxBuckets ?? DEFAULT_MAX_BUCKETS, 1);
    this.now = options.now ?? (() => Date.now());
  }

  check(key: string): RateLimitDecision {
    const now = this.now();

    const existing = this.buckets.get(key);
    if (!existing || existing.resetAt <= now) {
      // Opportunistic bounded cleanup: instead of scanning every bucket on
      // every request (O(n) per call), sweep only when the map reaches its
      // cap. When still at cap after sweeping, fail closed rather than grow
      // unbounded (see AUDIT.md H13).
      if (!existing && this.buckets.size >= this.maxBuckets) {
        this.prune(now);
        if (this.buckets.size >= this.maxBuckets) {
          return {
            allowed: false,
            remaining: 0,
            retryAfterMs: this.windowMs,
          };
        }
      }
      const bucket: RateLimitBucket = {
        count: 1,
        resetAt: now + this.windowMs,
      };
      this.buckets.set(key, bucket);
      return {
        allowed: true,
        remaining: Math.max(this.maxRequests - 1, 0),
        retryAfterMs: 0,
      };
    }

    if (existing.count >= this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(existing.resetAt - now, 0),
      };
    }

    existing.count += 1;
    return {
      allowed: true,
      remaining: Math.max(this.maxRequests - existing.count, 0),
      retryAfterMs: 0,
    };
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) {
        this.buckets.delete(key);
      }
    }
  }
}
