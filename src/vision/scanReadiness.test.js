import { describe, it, expect } from 'vitest';
import { calculatePoseReadiness, calculateFrameReadiness } from './scanReadiness';

describe('calculatePoseReadiness', () => {
    describe('directional poses (left/right/up/down)', () => {
        it('is 0% at dead center', () => {
            expect(calculatePoseReadiness('left', 0, 0, 0.06, 0.06)).toBe(0);
            expect(calculatePoseReadiness('right', 0, 0, 0.06, 0.06)).toBe(0);
        });

        it('is 100% exactly at the achievement threshold', () => {
            expect(calculatePoseReadiness('right', 0.06, 0, 0.06, 0.06)).toBe(100);
            expect(calculatePoseReadiness('left', -0.06, 0, 0.06, 0.06)).toBe(100);
            expect(calculatePoseReadiness('down', 0, 0.06, 0.06, 0.06)).toBe(100);
            expect(calculatePoseReadiness('up', 0, -0.06, 0.06, 0.06)).toBe(100);
        });

        it('is roughly halfway at half the threshold', () => {
            expect(calculatePoseReadiness('right', 0.03, 0, 0.06, 0.06)).toBeCloseTo(50, 0);
        });

        it('clamps at 100% past the threshold, never exceeding it', () => {
            expect(calculatePoseReadiness('right', 0.5, 0, 0.06, 0.06)).toBe(100);
        });

        it('does not credit turning the wrong direction', () => {
            // Turning right (positive yaw) should not progress the "left" pose.
            expect(calculatePoseReadiness('left', 0.06, 0, 0.06, 0.06)).toBe(0);
            expect(calculatePoseReadiness('right', -0.06, 0, 0.06, 0.06)).toBe(0);
        });
    });

    describe('center pose', () => {
        it('is 100% at dead center', () => {
            expect(calculatePoseReadiness('center', 0, 0, 0.08, 0.10)).toBe(100);
        });

        it('is 0% once yaw or pitch reaches its own threshold', () => {
            expect(calculatePoseReadiness('center', 0.08, 0, 0.08, 0.10)).toBe(0);
            expect(calculatePoseReadiness('center', 0, 0.10, 0.08, 0.10)).toBe(0);
        });

        it('scores by whichever axis is proportionally further off-center', () => {
            // yaw is at 50% of its threshold, pitch at 20% -- yaw should dominate.
            expect(calculatePoseReadiness('center', 0.04, 0.02, 0.08, 0.10)).toBeCloseTo(50, 0);
        });
    });

    it('returns 0 for an unrecognized pose name', () => {
        expect(calculatePoseReadiness('sideways', 0, 0, 0.06, 0.06)).toBe(0);
    });
});

describe('calculateFrameReadiness', () => {
    it('is 100 when every check passes', () => {
        expect(calculateFrameReadiness({ framing: true, brightness: true, lens: true })).toBe(100);
    });

    it('is 0 when every check fails', () => {
        expect(calculateFrameReadiness({ framing: false, brightness: false })).toBe(0);
    });

    it('splits proportionally between passing and failing checks', () => {
        expect(calculateFrameReadiness({ framing: true, brightness: false, lens: true, occlusion: false })).toBe(50);
    });

    it('returns 0 for an empty/missing checks object', () => {
        expect(calculateFrameReadiness({})).toBe(0);
        expect(calculateFrameReadiness(undefined)).toBe(0);
    });
});
