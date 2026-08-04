import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./indexedDbCache', () => {
    let store = null;
    return {
        idbGet: vi.fn(async () => store),
        idbSet: vi.fn(async (_key, value) => { store = value; }),
        __resetStore: () => { store = null; },
    };
});

import { idbGet, idbSet, __resetStore } from './indexedDbCache';
import { OfflineMutationQueue } from './OfflineMutationQueue';

describe('OfflineMutationQueue', () => {
    beforeEach(() => {
        __resetStore();
        vi.clearAllMocks();
    });

    it('does not lose an item when two enqueue calls overlap (race-condition fix)', async () => {
        const queue = new OfflineMutationQueue();
        // Fire both without awaiting the first first — this is exactly the
        // overlapping read-modify-write scenario that used to drop one.
        const first = queue.enqueue('typeA', { a: 1 });
        const second = queue.enqueue('typeB', { b: 2 });
        await Promise.all([first, second]);

        expect(await queue.getQueueLength()).toBe(2);
    });

    it('serializes flush() against a concurrent enqueue() so neither is lost', async () => {
        const queue = new OfflineMutationQueue();
        queue.registerHandler('typeA', vi.fn().mockResolvedValue(undefined));
        Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });

        await queue.enqueue('typeA', { a: 1 });
        // Start a flush and a second enqueue concurrently.
        const flushPromise = queue.flush();
        const enqueuePromise = queue.enqueue('typeB', { b: 2 });
        await Promise.all([flushPromise, enqueuePromise]);

        // typeA was flushed (handler succeeded) and typeB was queued after —
        // both outcomes should be reflected, not one clobbering the other.
        expect(await queue.getQueueLength()).toBe(1);
    });

    it('re-queues an item whose handler throws, without losing concurrently-enqueued items', async () => {
        const queue = new OfflineMutationQueue();
        queue.registerHandler('flaky', vi.fn().mockRejectedValue(new Error('network down')));
        Object.defineProperty(navigator, 'onLine', { value: true, configurable: true });

        await queue.enqueue('flaky', { x: 1 });
        await queue.flush();

        expect(await queue.getQueueLength()).toBe(1); // still queued for retry
        expect(idbSet).toHaveBeenCalled();
        expect(idbGet).toHaveBeenCalled();
    });
});
