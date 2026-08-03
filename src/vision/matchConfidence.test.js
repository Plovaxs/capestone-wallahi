import { describe, it, expect } from 'vitest';
import { classifyMatch } from './matchConfidence';

describe('classifyMatch', () => {
    const threshold = 0.5;

    it('classifies a well-under-threshold distance as a confident match', () => {
        expect(classifyMatch(0.2, threshold)).toBe('confident-match');
    });

    it('classifies a distance just under the threshold as borderline', () => {
        expect(classifyMatch(0.48, threshold)).toBe('borderline-match');
    });

    it('classifies a distance over the threshold as no-match', () => {
        expect(classifyMatch(0.9, threshold)).toBe('no-match');
    });

    it('respects a custom borderline margin', () => {
        expect(classifyMatch(0.3, threshold, { borderlineMargin: 0.35 })).toBe('borderline-match');
    });
});
