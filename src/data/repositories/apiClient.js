import { createPipeline } from '../pipeline/middlewarePipeline';
import { loggingMiddleware, errorTransformMiddleware } from '../pipeline/middlewares';
import { retryWithBackoff } from '../pipeline/retryWithBackoff';
import { createCircuitBreaker } from '../pipeline/circuitBreaker';

const pipeline = createPipeline([loggingMiddleware, errorTransformMiddleware]);
const breaker = createCircuitBreaker({ failureThreshold: 5, cooldownMs: 20000 });

/**
 * Single choke point every repository read goes through:
 * middleware chain (logging + error normalization) -> circuit breaker
 * (fail fast once the backend looks unhealthy) -> retry with backoff
 * (transient network blips only). Reads are idempotent, so retrying is safe.
 */
export function runQuery(label, supabaseCallFn) {
    return pipeline({ label }, () =>
        breaker(() =>
            retryWithBackoff(async () => {
                const { data, error } = await supabaseCallFn();
                if (error) throw error;
                return data;
            }, { retries: 2 })
        )
    );
}

/**
 * Writes go through the same logging/error/circuit-breaker treatment but
 * deliberately skip retryWithBackoff — retrying a mutation blindly risks
 * double-applying it if the first attempt actually succeeded server-side
 * and only the response was lost in transit.
 */
export function runMutation(label, supabaseCallFn) {
    return pipeline({ label }, () =>
        breaker(async () => {
            const { data, error } = await supabaseCallFn();
            if (error) throw error;
            return data;
        })
    );
}
