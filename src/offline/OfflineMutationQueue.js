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
        if (typeof window !== 'undefined') {
            window.addEventListener('online', () => this.flush());
        }
    }

    registerHandler(type, handler) {
        this.handlers.set(type, handler);
    }

    async enqueue(type, payload) {
        const queue = (await idbGet(QUEUE_KEY)) || [];
        queue.push({ type, payload, queuedAt: Date.now() });
        await idbSet(QUEUE_KEY, queue);
        this._registerBackgroundSync();
    }

    async _registerBackgroundSync() {
        try {
            const registration = await navigator.serviceWorker?.ready;
            if (registration?.sync) await registration.sync.register('offline-mutation-flush');
        } catch {
            // Background Sync unsupported — the 'online' listener above covers it
        }
    }

    async flush() {
        if (!navigator.onLine) return;
        const queue = (await idbGet(QUEUE_KEY)) || [];
        if (queue.length === 0) return;

        const remaining = [];
        for (const item of queue) {
            const handler = this.handlers.get(item.type);
            try {
                if (handler) await handler(item.payload);
            } catch {
                remaining.push(item); // couldn't apply yet — keep it queued and retry next flush
            }
        }
        await idbSet(QUEUE_KEY, remaining);
    }

    async getQueueLength() {
        const queue = (await idbGet(QUEUE_KEY)) || [];
        return queue.length;
    }
}

export const offlineMutationQueue = new OfflineMutationQueue();
