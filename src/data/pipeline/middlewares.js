export class ApiError extends Error {
    constructor(label, cause) {
        super(`${label} failed: ${cause?.message || cause}`);
        this.name = 'ApiError';
        this.cause = cause;
    }
}

/**
 * Logs duration + outcome of every repository call. Success logs only run
 * in development — every table-change realtime event triggers a refetch,
 * so this line potentially runs very often in a busy multi-user session;
 * gating it keeps production consoles/CPU quiet. Failures still always log
 * since a silent, unrecoverable Supabase error is worse than console noise.
 */
export const loggingMiddleware = async (ctx, next) => {
    const start = performance.now();
    try {
        const result = await next();
        if (import.meta.env.DEV) {
            console.debug(`[api] ${ctx.label} ok in ${(performance.now() - start).toFixed(1)}ms`);
        }
        return result;
    } catch (err) {
        console.error(`[api] ${ctx.label} failed in ${(performance.now() - start).toFixed(1)}ms —`, err);
        throw err;
    }
};

/** Normalizes whatever the call throws into a typed ApiError carrying the original cause. */
export const errorTransformMiddleware = async (ctx, next) => {
    try {
        return await next();
    } catch (err) {
        throw new ApiError(ctx.label, err);
    }
};
