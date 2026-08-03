const State = { CLOSED: 'CLOSED', OPEN: 'OPEN', HALF_OPEN: 'HALF_OPEN' };

/**
 * Classic circuit breaker: after `failureThreshold` consecutive failures,
 * trips OPEN and short-circuits every call for `cooldownMs` without even
 * attempting the network request (fail fast instead of piling up timeouts
 * against a backend that's already struggling). After the cooldown it lets
 * exactly one HALF_OPEN probe through; success closes the circuit again,
 * failure re-opens it.
 */
export function createCircuitBreaker({ failureThreshold = 5, cooldownMs = 20000 } = {}) {
    let state = State.CLOSED;
    let failureCount = 0;
    let openedAt = 0;

    return async function execute(fn) {
        if (state === State.OPEN) {
            if (Date.now() - openedAt > cooldownMs) {
                state = State.HALF_OPEN;
            } else {
                const waitMs = cooldownMs - (Date.now() - openedAt);
                throw new Error(`Circuit breaker open — short-circuited (retry in ${Math.ceil(waitMs / 1000)}s)`);
            }
        }

        try {
            const result = await fn();
            state = State.CLOSED;
            failureCount = 0;
            return result;
        } catch (err) {
            failureCount += 1;
            if (state === State.HALF_OPEN || failureCount >= failureThreshold) {
                state = State.OPEN;
                openedAt = Date.now();
            }
            throw err;
        }
    };
}
