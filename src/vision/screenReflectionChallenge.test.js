import { describe, it, expect } from 'vitest';
import { ScreenReflectionChallenge, calculateAverageRGB, pickRandomFlashSequence } from './screenReflectionChallenge';

describe('calculateAverageRGB', () => {
    it('averages R, G, B across an RGBA buffer', () => {
        // 2 pixels: (100, 50, 0) and (0, 50, 100) -> average (50, 50, 50)
        const data = new Uint8ClampedArray([100, 50, 0, 255, 0, 50, 100, 255]);
        expect(calculateAverageRGB(data)).toEqual([50, 50, 50]);
    });

    it('returns [0,0,0] for empty/invalid input', () => {
        expect(calculateAverageRGB(null)).toEqual([0, 0, 0]);
        expect(calculateAverageRGB(new Uint8ClampedArray(0))).toEqual([0, 0, 0]);
    });
});

describe('pickRandomFlashSequence', () => {
    it('returns the requested number of steps, each a valid RGB color', () => {
        const sequence = pickRandomFlashSequence(5);
        expect(sequence).toHaveLength(5);
        for (const step of sequence) {
            expect(step.rgb).toHaveLength(3);
            expect(typeof step.name).toBe('string');
        }
    });
});

describe('ScreenReflectionChallenge', () => {
    const redSequence = [{ name: 'red', rgb: [230, 40, 40] }];

    it('confirms when the observed color delta matches the flashed color (a real reflective face)', () => {
        const challenge = new ScreenReflectionChallenge({ sequence: redSequence });
        challenge.recordBaseline([120, 100, 90]); // neutral skin-ish tone
        // Under a red flash, a real face gets noticeably redder -- R rises more than G/B.
        challenge.recordFlashSample([150, 102, 91]);
        expect(challenge.isComplete).toBe(true);
        expect(challenge.confirmed).toBe(true);
        expect(challenge.failed).toBe(false);
    });

    it('does NOT confirm when the observed delta is unrelated to the flashed color (a photo/screen not responding to the new flash)', () => {
        const challenge = new ScreenReflectionChallenge({ sequence: redSequence });
        challenge.recordBaseline([120, 100, 90]);
        // No meaningful change at all despite a red flash -- flat response, as a static image would show.
        challenge.recordFlashSample([120, 100, 90]);
        expect(challenge.confirmed).toBe(false);
        expect(challenge.failed).toBe(true);
    });

    it('does NOT confirm when the delta moves the OPPOSITE way from the flashed color', () => {
        const challenge = new ScreenReflectionChallenge({ sequence: redSequence });
        challenge.recordBaseline([120, 100, 90]);
        // Face gets bluer/greener despite a RED flash -- the opposite of a real reflection.
        challenge.recordFlashSample([90, 130, 140]);
        expect(challenge.confirmed).toBe(false);
    });

    it('averages the score across multiple sequential flash steps', () => {
        const sequence = [
            { name: 'red', rgb: [230, 40, 40] },
            { name: 'blue', rgb: [50, 90, 230] },
        ];
        const challenge = new ScreenReflectionChallenge({ sequence });
        challenge.recordBaseline([120, 100, 90]);
        challenge.recordFlashSample([150, 102, 91]); // matches red
        expect(challenge.isComplete).toBe(false);

        challenge.recordBaseline([120, 100, 90]);
        challenge.recordFlashSample([118, 99, 125]); // matches blue
        expect(challenge.isComplete).toBe(true);
        expect(challenge.confirmed).toBe(true);
    });

    it('ignores a flash sample recorded without a baseline first', () => {
        const challenge = new ScreenReflectionChallenge({ sequence: redSequence });
        challenge.recordFlashSample([150, 102, 91]); // no recordBaseline() call first
        expect(challenge.stepIndex).toBe(0);
        expect(challenge.isComplete).toBe(false);
    });

    it('reset() starts a fresh sequence and clears prior results', () => {
        const challenge = new ScreenReflectionChallenge({ sequence: redSequence });
        challenge.recordBaseline([120, 100, 90]);
        challenge.recordFlashSample([150, 102, 91]);
        expect(challenge.isComplete).toBe(true);

        challenge.reset(redSequence);
        expect(challenge.isComplete).toBe(false);
        expect(challenge.confirmed).toBe(false);
        expect(challenge.scores).toEqual([]);
    });
});
