/**
 * Classic LRU (Least Recently Used) cache built on a Map, whose insertion
 * order doubles as recency order: touching a key re-inserts it at the end
 * of iteration order, and once `capacity` is exceeded the oldest (first)
 * entry is evicted.
 */
export class LRUCache {
    constructor(capacity = 20) {
        this.capacity = capacity;
        this.map = new Map();
    }

    get(key) {
        if (!this.map.has(key)) return undefined;
        const value = this.map.get(key);
        this.map.delete(key);
        this.map.set(key, value);
        return value;
    }

    set(key, value) {
        if (this.map.has(key)) this.map.delete(key);
        this.map.set(key, value);
        if (this.map.size > this.capacity) {
            const oldestKey = this.map.keys().next().value;
            this.map.delete(oldestKey);
        }
    }

    has(key) {
        return this.map.has(key);
    }

    clear() {
        this.map.clear();
    }

    get size() {
        return this.map.size;
    }
}

/**
 * Wraps a pure function with LRU memoization. `keyFn` should be cheap —
 * for large arrays, prefer a summary (lengths + ids joined) over
 * JSON.stringify-ing the whole payload, or the cache key computation
 * itself becomes the bottleneck it's meant to avoid.
 */
export function memoizeWithLru(fn, { capacity = 20, keyFn = (...args) => JSON.stringify(args) } = {}) {
    const cache = new LRUCache(capacity);
    const memoized = (...args) => {
        const key = keyFn(...args);
        if (cache.has(key)) return cache.get(key);
        const result = fn(...args);
        cache.set(key, result);
        return result;
    };
    memoized.cache = cache;
    return memoized;
}
