import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withTimeout } from './withTimeout';

describe('withTimeout', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('resolves with the underlying value when it settles before the timeout', async () => {
        const promise = withTimeout(Promise.resolve('ok'), 1000);
        await expect(promise).resolves.toBe('ok');
    });

    it('rejects with the underlying error when it rejects before the timeout', async () => {
        const promise = withTimeout(Promise.reject(new Error('boom')), 1000);
        await expect(promise).rejects.toThrow('boom');
    });

    it('rejects with a timeout error if the promise never settles in time', async () => {
        const neverSettles = new Promise(() => {});
        const promise = withTimeout(neverSettles, 1000, 'my-request');
        const assertion = expect(promise).rejects.toThrow(/my-request timed out after 1000ms/);
        await vi.advanceTimersByTimeAsync(1000);
        await assertion;
    });

    it('does not fire the timeout once the promise has already resolved', async () => {
        const promise = withTimeout(Promise.resolve('fast'), 1000);
        await expect(promise).resolves.toBe('fast');
        // Advancing time after resolution must not throw an unhandled rejection.
        await vi.advanceTimersByTimeAsync(2000);
    });
});
