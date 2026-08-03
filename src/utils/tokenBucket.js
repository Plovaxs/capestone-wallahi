/**
 * Classic token-bucket algorithm: a bucket holding up to `capacity` tokens,
 * refilling continuously at `refillRatePerSec` tokens/sec. Each attempt
 * consumes one token if available.
 *
 * Used purely as a client-side pre-throttle (instant feedback, fewer
 * wasted round trips when a user mashes a button) — NOT a security
 * boundary. It's trivially bypassable client-side (clear state, edit JS),
 * so it must always sit in front of an authoritative server-side check,
 * never replace one. See utils/rateLimit.js.
 */
export class TokenBucket {
    constructor({ capacity, refillRatePerSec }) {
        this.capacity = capacity;
        this.refillRatePerSec = refillRatePerSec;
        this.tokens = capacity;
        this.lastRefill = Date.now();
    }

    _refill() {
        const now = Date.now();
        const elapsedSec = (now - this.lastRefill) / 1000;
        this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillRatePerSec);
        this.lastRefill = now;
    }

    tryConsume(cost = 1) {
        this._refill();
        if (this.tokens >= cost) {
            this.tokens -= cost;
            return true;
        }
        return false;
    }

    msUntilNextToken() {
        this._refill();
        if (this.tokens >= 1) return 0;
        return Math.ceil(((1 - this.tokens) / this.refillRatePerSec) * 1000);
    }
}

const buckets = new Map();

/** Returns the shared bucket for `key`, creating it on first use. */
export function getBucket(key, { capacity, refillRatePerSec }) {
    if (!buckets.has(key)) {
        buckets.set(key, new TokenBucket({ capacity, refillRatePerSec }));
    }
    return buckets.get(key);
}
