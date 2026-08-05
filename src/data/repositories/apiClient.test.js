import { describe, it, expect, vi } from 'vitest';
import { runQuery, runMutation } from './apiClient';

describe('runQuery', () => {
    it('resolves with the data on success', async () => {
        const result = await runQuery('test.success', async () => ({ data: { hello: 'world' }, error: null }));
        expect(result).toEqual({ hello: 'world' });
    });

    it('throws when the Supabase call returns an error', async () => {
        await expect(
            runQuery('test.error-case', async () => ({ data: null, error: new Error('db down') }))
        ).rejects.toThrow();
    });

    it('deduplicates concurrent calls sharing the same label into one underlying call', async () => {
        const callFn = vi.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { data: 'shared-result', error: null };
        });

        const [a, b, c] = await Promise.all([
            runQuery('test.dedupe', callFn),
            runQuery('test.dedupe', callFn),
            runQuery('test.dedupe', callFn),
        ]);

        expect(callFn).toHaveBeenCalledTimes(1);
        expect(a).toBe('shared-result');
        expect(b).toBe('shared-result');
        expect(c).toBe('shared-result');
    });

    it('does not deduplicate calls with different labels', async () => {
        const callFn = vi.fn(async () => ({ data: 'x', error: null }));

        await Promise.all([runQuery('test.label-a', callFn), runQuery('test.label-b', callFn)]);

        expect(callFn).toHaveBeenCalledTimes(2);
    });

    it('allows a fresh call after the in-flight one settles (no permanent coalescing)', async () => {
        const callFn = vi.fn(async () => ({ data: 'x', error: null }));

        await runQuery('test.sequential', callFn);
        await runQuery('test.sequential', callFn);

        expect(callFn).toHaveBeenCalledTimes(2);
    });
});

describe('runMutation', () => {
    it('resolves with the data on success', async () => {
        const result = await runMutation('test.mutate', async () => ({ data: { id: 1 }, error: null }));
        expect(result).toEqual({ id: 1 });
    });

    it('throws when the Supabase call returns an error', async () => {
        await expect(
            runMutation('test.mutate-error', async () => ({ data: null, error: new Error('write failed') }))
        ).rejects.toThrow();
    });

    it('does NOT deduplicate concurrent mutations sharing a label (each write is distinct)', async () => {
        const callFn = vi.fn(async () => ({ data: 'x', error: null }));

        await Promise.all([runMutation('test.mutate-dedupe', callFn), runMutation('test.mutate-dedupe', callFn)]);

        expect(callFn).toHaveBeenCalledTimes(2);
    });

    it('rejects instead of hanging forever when the Supabase call never settles (weak-network mitigation)', async () => {
        vi.useFakeTimers();
        try {
            const neverSettles = () => new Promise(() => {});
            const promise = runMutation('test.mutate-hang', neverSettles);
            const assertion = expect(promise).rejects.toThrow(/timed out/);
            await vi.advanceTimersByTimeAsync(20000);
            await assertion;
        } finally {
            vi.useRealTimers();
        }
    });
});
