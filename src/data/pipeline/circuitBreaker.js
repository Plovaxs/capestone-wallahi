const State = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

/**
 * Classic circuit breaker: after `failureThreshold` consecutive failures,
 * trips OPEN and short-circuits every call for a cooldown window without
 * even attempting the network request (fail fast instead of piling up
 * timeouts against a backend that's already struggling). After the
 * cooldown it lets exactly one HALF_OPEN probe through; success closes
 * the circuit again, failure re-opens it.
 *
 * Adaptive backoff: each consecutive OPEN trip (one that re-trips before
 * the circuit ever got back to a healthy CLOSED state) doubles the
 * cooldown, up to `maxCooldownMs` — a backend that keeps failing gets
 * backed off harder each time instead of being re-probed on the same
 * fixed interval forever. A single isolated failure that recovers resets
 * the backoff back to `cooldownMs`.
 */
export function createCircuitBreaker({ failureThreshold = 5, cooldownMs = 20000, maxCooldownMs = 5 * 60 * 1000 } = {}) {
    let state = State.CLOSED;
    let failureCount = 0;
    let openedAt = 0;
    let currentCooldownMs = cooldownMs;

    return async function execute(fn) {
        if (state === State.OPEN) {
            if (Date.now() - openedAt > currentCooldownMs) {
                state = State.HALF_OPEN;
            } else {
                const waitMs = currentCooldownMs - (Date.now() - openedAt);
                throw new Error(`Circuit breaker open — short-circuited (retry in ${Math.ceil(waitMs / 1000)}s)`);
            }
        }

        try {
            const result = await fn();
            state = State.CLOSED;
            failureCount = 0;
            currentCooldownMs = cooldownMs; // fully recovered — reset backoff
            return result;
        } catch (err) {
            failureCount += 1;
            if (state === State.HALF_OPEN) {
                // The probe itself failed — back off harder next time.
                currentCooldownMs = Math.min(currentCooldownMs * 2, maxCooldownMs);
                state = State.OPEN;
                openedAt = Date.now();
            } else if (failureCount >= failureThreshold) {
                state = State.OPEN;
                openedAt = Date.now();
            }
            throw err;
        }
    };
}
