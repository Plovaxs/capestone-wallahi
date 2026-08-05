/**
 * A weak-but-connected network (packets going through, just very slowly or
 * lossily) is a different failure mode than being fully offline: the
 * browser never raises a network error, so a hung `fetch` just... never
 * resolves. Neither retryWithBackoff nor the circuit breaker can help with
 * that -- both only react to a thrown/rejected promise, and a hung request
 * throws nothing. This races the real request against a timer so the
 * CALLER stops waiting and gets an actionable error instead of a spinner
 * stuck forever, even though the underlying `fetch` isn't actually
 * cancelled (still no AbortSignal threaded through every call site) and
 * may go on to resolve in the background, its result just ignored.
 */
export function withTimeout(promise, ms, label = 'request') {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`${label} timed out after ${ms}ms — the network may be too slow or unstable`));
        }, ms);

        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (err) => { clearTimeout(timer); reject(err); }
        );
    });
}
