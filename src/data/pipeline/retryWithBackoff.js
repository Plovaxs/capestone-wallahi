/**
 * Retries `fn` with exponential backoff + jitter. Only meant for
 * idempotent operations (reads) — retrying a write blindly risks
 * double-applying a mutation if the first attempt actually succeeded
 * server-side but the response was lost, so writes should NOT use this.
 */
export async function retryWithBackoff(fn, { retries = 2, baseDelayMs = 300, maxDelayMs = 4000 } = {}) {
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        } catch (err) {
            attempt += 1;
            if (attempt > retries) throw err;
            const jitter = 0.75 + Math.random() * 0.5;
            const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)) * jitter;
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
    }
}
