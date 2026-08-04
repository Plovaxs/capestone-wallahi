import { describe, it, expect } from 'vitest';
import { normalizeStoredTemplates, matchAgainstTemplates } from './multiTemplateMatcher';

const makeDescriptor = (fillValue) => Array.from({ length: 128 }, () => fillValue);

const euclideanDistance = (a, b) => {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += (a[i] - b[i]) ** 2;
    return Math.sqrt(sum);
};

describe('normalizeStoredTemplates', () => {
    it('returns an empty array for null/undefined input', () => {
        expect(normalizeStoredTemplates(null)).toEqual([]);
        expect(normalizeStoredTemplates(undefined)).toEqual([]);
    });

    it('wraps a legacy flat single-descriptor array as one template', () => {
        const legacy = makeDescriptor(0.1);
        const result = normalizeStoredTemplates(legacy);
        expect(result).toHaveLength(1);
        expect(result[0]).toHaveLength(128);
    });

    it('passes through a multi-template array of arrays as-is', () => {
        const multi = [makeDescriptor(0.1), makeDescriptor(0.2), makeDescriptor(0.3)];
        const result = normalizeStoredTemplates(multi);
        expect(result).toHaveLength(3);
    });

    it('filters out malformed templates (wrong length)', () => {
        const mixed = [makeDescriptor(0.1), [1, 2, 3], makeDescriptor(0.2)];
        const result = normalizeStoredTemplates(mixed);
        expect(result).toHaveLength(2);
    });

    it('handles the { data: [...] } Float32Array-serialized shape', () => {
        const wrapped = { data: makeDescriptor(0.1) };
        const result = normalizeStoredTemplates(wrapped);
        expect(result).toHaveLength(1);
    });
});

describe('matchAgainstTemplates', () => {
    it('returns Infinity distance when there are no templates', () => {
        const result = matchAgainstTemplates(makeDescriptor(0), [], euclideanDistance);
        expect(result.distance).toBe(Infinity);
        expect(result.templateIndex).toBe(-1);
    });

    it('returns the best (lowest) distance across all templates', () => {
        const live = makeDescriptor(0.5);
        const templates = [makeDescriptor(0), makeDescriptor(0.5), makeDescriptor(1)];
        const result = matchAgainstTemplates(live, templates, euclideanDistance);
        expect(result.templateIndex).toBe(1);
        expect(result.distance).toBe(0);
    });

    it('identifies which template index produced the best match', () => {
        const live = makeDescriptor(0.9);
        const templates = [makeDescriptor(0), makeDescriptor(0.3), makeDescriptor(1)];
        const result = matchAgainstTemplates(live, templates, euclideanDistance);
        expect(result.templateIndex).toBe(2);
    });
});
