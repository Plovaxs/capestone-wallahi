import { describe, it, expect } from 'vitest';
import { evaluatePassiveLiveness } from './livenessFusion';

describe('evaluatePassiveLiveness', () => {
    it('is not suspicious when no signals fire', () => {
        const result = evaluatePassiveLiveness({ a: false, b: false, c: false });
        expect(result.suspicious).toBe(false);
        expect(result.votes).toBe(0);
    });

    it('is not suspicious when only a single signal fires (avoids one noisy heuristic blocking a real user)', () => {
        const result = evaluatePassiveLiveness({ a: true, b: false, c: false, d: false });
        expect(result.suspicious).toBe(false);
        expect(result.votes).toBe(1);
    });

    it('is suspicious once at least 2 independent signals agree', () => {
        const result = evaluatePassiveLiveness({ a: true, b: true, c: false, d: false });
        expect(result.suspicious).toBe(true);
        expect(result.votes).toBe(2);
    });

    it('flags the exact "photo with a normal, textured background" case a single AND-gate on border-uniformity used to miss', () => {
        // border-uniformity never fires (real room visible around the photo),
        // but motion is flat AND color/texture looks unnatural -- 2 votes.
        const result = evaluatePassiveLiveness({
            borderUniform: false,
            pixelFlat: true,
            colorSuspicious: true,
            textureFlat: false,
        });
        expect(result.suspicious).toBe(true);
    });

    it('ignores null/undefined signals (not available this tick) rather than counting them as non-suspicious votes', () => {
        const result = evaluatePassiveLiveness({ a: true, b: null, c: undefined });
        expect(result.total).toBe(1);
        expect(result.suspicious).toBe(false);
    });

    it('requires at least 2 total available signals even if the only one available is suspicious', () => {
        const result = evaluatePassiveLiveness({ a: true, b: null });
        expect(result.total).toBe(1);
        expect(result.suspicious).toBe(false);
    });
});
