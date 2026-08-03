import { describe, it, expect, vi } from 'vitest';
import { LRUCache, memoizeWithLru } from './LRUCache';

describe('LRUCache', () => {
    it('stores and retrieves values', () => {
        const cache = new LRUCache(2);
        cache.set('a', 1);
        expect(cache.get('a')).toBe(1);
    });

    it('evicts the least recently used entry once over capacity', () => {
        const cache = new LRUCache(2);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.set('c', 3); // evicts 'a' (oldest, untouched)

        expect(cache.has('a')).toBe(false);
        expect(cache.has('b')).toBe(true);
        expect(cache.has('c')).toBe(true);
    });

    it('touching an entry via get() protects it from eviction', () => {
        const cache = new LRUCache(2);
        cache.set('a', 1);
        cache.set('b', 2);
        cache.get('a'); // 'a' is now most-recently-used
        cache.set('c', 3); // should evict 'b', not 'a'

        expect(cache.has('a')).toBe(true);
        expect(cache.has('b')).toBe(false);
        expect(cache.has('c')).toBe(true);
    });
});

describe('memoizeWithLru', () => {
    it('only calls the underlying function once per distinct key', () => {
        const fn = vi.fn((x) => x * 2);
        const memoized = memoizeWithLru(fn, { keyFn: (x) => String(x) });

        expect(memoized(5)).toBe(10);
        expect(memoized(5)).toBe(10);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('recomputes for a genuinely different key', () => {
        const fn = vi.fn((x) => x * 2);
        const memoized = memoizeWithLru(fn, { keyFn: (x) => String(x) });

        memoized(5);
        memoized(6);
        expect(fn).toHaveBeenCalledTimes(2);
    });
});
