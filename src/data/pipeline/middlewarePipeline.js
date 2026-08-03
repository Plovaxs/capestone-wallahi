/**
 * Express-style composable middleware chain. Each middleware receives the
 * shared `context` and a `next()` continuation; it can run logic before
 * and/or after calling next(), short-circuit by not calling it, or throw.
 */
export function createPipeline(middlewares = []) {
    return function runPipeline(context, finalHandler) {
        let index = -1;

        function dispatch(i) {
            if (i <= index) throw new Error('next() called multiple times in middleware pipeline');
            index = i;
            const middleware = middlewares[i];
            if (!middleware) return finalHandler(context);
            return middleware(context, () => dispatch(i + 1));
        }

        return dispatch(0);
    };
}
