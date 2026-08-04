import { describe, it, expect, vi } from 'vitest';
import { isTorchSupported, setTorch } from './torchControl';

function makeStream({ capabilities, applyConstraints } = {}) {
    return {
        getVideoTracks: () => [{
            getCapabilities: capabilities ? () => capabilities : undefined,
            applyConstraints: applyConstraints || vi.fn().mockResolvedValue(undefined),
        }],
    };
}

describe('isTorchSupported', () => {
    it('returns true when the track reports a torch capability', () => {
        expect(isTorchSupported(makeStream({ capabilities: { torch: true } }))).toBe(true);
    });

    it('returns false when the track has no torch capability (typical laptop webcam)', () => {
        expect(isTorchSupported(makeStream({ capabilities: { torch: false } }))).toBe(false);
    });

    it('returns false when getCapabilities is unavailable entirely', () => {
        expect(isTorchSupported(makeStream({ capabilities: undefined }))).toBe(false);
    });

    it('returns false for a null/undefined stream instead of throwing', () => {
        expect(isTorchSupported(null)).toBe(false);
        expect(isTorchSupported(undefined)).toBe(false);
    });
});

describe('setTorch', () => {
    it('applies the torch constraint when supported', async () => {
        const applyConstraints = vi.fn().mockResolvedValue(undefined);
        const stream = makeStream({ capabilities: { torch: true }, applyConstraints });
        const result = await setTorch(stream, true);
        expect(result).toBe(true);
        expect(applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] });
    });

    it('no-ops and returns false when torch is unsupported', async () => {
        const applyConstraints = vi.fn();
        const stream = makeStream({ capabilities: { torch: false }, applyConstraints });
        const result = await setTorch(stream, true);
        expect(result).toBe(false);
        expect(applyConstraints).not.toHaveBeenCalled();
    });

    it('swallows a rejected applyConstraints instead of throwing', async () => {
        const applyConstraints = vi.fn().mockRejectedValue(new Error('not allowed'));
        const stream = makeStream({ capabilities: { torch: true }, applyConstraints });
        await expect(setTorch(stream, true)).resolves.toBe(false);
    });
});
