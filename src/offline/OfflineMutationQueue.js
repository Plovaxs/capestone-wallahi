import { idbGet, idbSet } from './indexedDbCache';

const QUEUE_KEY = 'offline_mutation_queue';

/**
 * Queues a mutation while offline and flushes it automatically once
 * connectivity returns. Attempts the real Background Sync API
 * (registration.sync.register) as a wake-up signal where it's supported
 * (Chrome/Edge) — but Background Sync isn't available in Firefox/Safari,
 * so the standard `online` DOM event is always registered too as the
 * universal fallback that makes this actually work everywhere.
 */
export class OfflineMutationQueue {
    constructor() {
        this.handlers = new Map();
        // 🟩 RACE-CONDITION FIX: enqueue() and flush() both do an unguarded
        // read-modify-write against the same IndexedDB-backed queue. Two
        // overlapping calls (e.g. the 'online' event firing twice in quick
        // succession, or enqueue() racing a flush() already in progress)
        // previously each read the same snapshot before either wrote back —
        // whichever write landed last silently discarded the other's
        // change, which could resurrect an already-flushed mutation (e.g. a
        // queued leave request replayed/inserted twice) or drop a newly
        // queued one entirely. `_chain` serializes every read-modify-write
        // so they can never overlap, regardless of how many times these are
        // called concurrently.
        this._chain = Promise.resolve();
        if (typeof window !== 'undefined') {
            window.addEventListener('online', () => this.flush());
        }
    }

    registerHandler(type, handler) {
        this.handlers.set(type, handler);
    }

    _serialize(fn) {
        const run = this._chain.then(fn, fn); // run fn regardless of whether the previous step rejected
        this._chain = run.catch(() => {}); // keep the chain alive even if fn itself throws
        return run;
    }

    enqueue(type, payload) {
        return this._serialize(async () => {
            const queue = (await idbGet(QUEUE_KEY)) || [];
            queue.push({ type, payload, queuedAt: Date.now() });
            await idbSet(QUEUE_KEY, queue);
            this._registerBackgroundSync();
        });
    }

    async _registerBackgroundSync() {
        try {
            const registration = await navigator.serviceWorker?.ready;
            if (registration?.sync) await registration.sync.register('offline-mutation-flush');
        } catch {
            // Background Sync unsupported — the 'online' listener above covers it
        }
    }

    flush() {
        return this._serialize(async () => {
            if (!navigator.onLine) return;
            const queue = (await idbGet(QUEUE_KEY)) || [];
            if (queue.length === 0) return;

            const remaining = [];
            for (const item of queue) {
                const handler = this.handlers.get(item.type);
                // 🟩 BUG FIX: no handler registered (e.g. flush() runs before
                // App.jsx's mount effect has called registerHandler() for
                // every type yet) used to fall through silently -- the item
                // was never applied but still got dropped from the queue
                // below as if it had succeeded. Keep it queued instead.
                if (!handler) {
                    remaining.push(item);
                    continue;
                }
                try {
                    await handler(item.payload);
                } catch {
                    remaining.push(item); // couldn't apply yet — keep it queued and retry next flush
                }
            }
            await idbSet(QUEUE_KEY, remaining);
        });
    }

    async getQueueLength() {
        const queue = (await idbGet(QUEUE_KEY)) || [];
        return queue.length;
    }
}

export const offlineMutationQueue = new OfflineMutationQueue();
