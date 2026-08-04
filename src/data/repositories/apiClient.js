import { createPipeline } from '../pipeline/middlewarePipeline';
import { loggingMiddleware, errorTransformMiddleware } from '../pipeline/middlewares';
import { retryWithBackoff } from '../pipeline/retryWithBackoff';
import { createCircuitBreaker } from '../pipeline/circuitBreaker';
import { apiSchemas } from '../../validation/apiSchemas';

// 🟩 RESPONSE SCHEMA VALIDATION: dev-only, warn-only. If the backend's
// actual shape drifts from what the app expects (a column renamed, a
// field that's suddenly null), the failure mode today is a confusing
// `undefined` bug three components downstream. This surfaces it as a
// clear console warning right at the source, during development — it
// deliberately never throws/blocks, so a schema this file doesn't know
// about yet (or a genuine intentional backend change) can't break
// production just because nobody updated apiSchemas.js in lockstep.
function warnOnSchemaDrift(label, data) {
    if (!import.meta.env.DEV) return;
    const schema = apiSchemas[label];
    if (!schema) return;
    const result = schema.safeParse(data);
    if (!result.success) {
        console.warn(`[api] response shape drift for "${label}":`, result.error.issues);
    }
}

const pipeline = createPipeline([loggingMiddleware, errorTransformMiddleware]);

// 🟩 PER-ENDPOINT CIRCUIT BREAKERS: one breaker per domain (the part of the
// label before the first '.', e.g. "tasks" from "tasks.listAll") instead of
// a single breaker shared by the entire app. A struggling `tasks` table
// used to trip the breaker for `attendance`/`leave`/every other domain too;
// now each domain fails independently.
const breakersByDomain = new Map();
function getBreakerFor(label) {
    const domain = label.split('.')[0];
    if (!breakersByDomain.has(domain)) {
        breakersByDomain.set(domain, createCircuitBreaker({ failureThreshold: 5, cooldownMs: 20000, maxCooldownMs: 5 * 60 * 1000 }));
    }
    return breakersByDomain.get(domain);
}

// 🟩 REQUEST DEDUPLICATION: if the exact same read (same label — e.g. two
// components both trigger "tasks.listAll" within the same tick, as
// happens when a realtime event and a manual refresh land together) is
// already in flight, the second caller just awaits the first call's
// promise instead of firing a redundant network request.
const inFlightQueries = new Map();

/**
 * Single choke point every repository read goes through:
 * middleware chain (logging + error normalization) -> in-flight
 * deduplication -> per-domain circuit breaker (fail fast once that
 * domain looks unhealthy) -> retry with backoff (transient network blips
 * only). Reads are idempotent, so retrying and deduplicating are both safe.
 */
export function runQuery(label, supabaseCallFn) {
    if (inFlightQueries.has(label)) {
        return inFlightQueries.get(label);
    }

    const promise = pipeline({ label }, () =>
        getBreakerFor(label)(() =>
            retryWithBackoff(async () => {
                const { data, error } = await supabaseCallFn();
                if (error) throw error;
                warnOnSchemaDrift(label, data);
                return data;
            }, { retries: 2 })
        )
    ).finally(() => {
        inFlightQueries.delete(label);
    });

    inFlightQueries.set(label, promise);
    return promise;
}

/**
 * Writes go through the same logging/error/circuit-breaker treatment but
 * deliberately skip both retryWithBackoff (retrying a mutation blindly
 * risks double-applying it if the first attempt actually succeeded
 * server-side and only the response was lost in transit) and
 * deduplication (two "identical-label" writes, e.g. two different task
 * updates, are not actually the same operation and must not be coalesced).
 */
export function runMutation(label, supabaseCallFn) {
    return pipeline({ label }, () =>
        getBreakerFor(label)(async () => {
            const { data, error } = await supabaseCallFn();
            if (error) throw error;
            return data;
        })
    );
}
