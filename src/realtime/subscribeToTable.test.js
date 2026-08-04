import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { debounce } from './subscribeToTable';

describe('debounce', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('coalesces a burst of calls into a single invocation', () => {
        const fn = vi.fn();
        const debounced = debounce(fn, 400);

        debounced();
        debounced();
        debounced();
        expect(fn).not.toHaveBeenCalled();

        vi.advanceTimersByTime(400);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('passes through the arguments of the last call', () => {
        const fn = vi.fn();
        const debounced = debounce(fn, 400);

        debounced('first');
        debounced('second');
        vi.advanceTimersByTime(400);

        expect(fn).toHaveBeenCalledWith('second');
    });

    it('fires again after a fresh burst once the delay has elapsed', () => {
        const fn = vi.fn();
        const debounced = debounce(fn, 400);

        debounced();
        vi.advanceTimersByTime(400);
        debounced();
        vi.advanceTimersByTime(400);

        expect(fn).toHaveBeenCalledTimes(2);
    });
});
