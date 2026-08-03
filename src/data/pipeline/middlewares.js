export class ApiError extends Error {
    constructor(label, cause) {
        super(`${label} failed: ${cause?.message || cause}`);
        this.name = 'ApiError';
        this.cause = cause;
    }
}

/** Logs duration + outcome of every repository call. */
export const loggingMiddleware = async (ctx, next) => {
    const start = performance.now();
    try {
        const result = await next();
        console.debug(`[api] ${ctx.label} ok in ${(performance.now() - start).toFixed(1)}ms`);
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
