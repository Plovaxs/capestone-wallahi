import { describe, it, expect } from 'vitest';
import { checkFraming, checkBrightness, checkOcclusion, checkSingleFace } from './faceQuality';

describe('checkFraming', () => {
    const imageWidth = 640;
    const imageHeight = 480;

    it('accepts a well-framed, centered, reasonably-sized face', () => {
        const box = { x: 260, y: 180, width: 120, height: 120 };
        expect(checkFraming(box, imageWidth, imageHeight)).toEqual({ ok: true, reason: null });
    });

    it('rejects a face that is too small (too far from camera)', () => {
        const box = { x: 300, y: 220, width: 20, height: 20 };
        expect(checkFraming(box, imageWidth, imageHeight)).toEqual({ ok: false, reason: 'too-far' });
    });

    it('rejects a face that fills almost the whole frame (too close)', () => {
        const box = { x: 0, y: 0, width: 630, height: 470 };
        expect(checkFraming(box, imageWidth, imageHeight)).toEqual({ ok: false, reason: 'too-close' });
    });

    it('rejects a face far off to one side', () => {
        const box = { x: 0, y: 200, width: 80, height: 150 };
        expect(checkFraming(box, imageWidth, imageHeight)).toEqual({ ok: false, reason: 'off-center' });
    });

    it('rejects when there is no box at all', () => {
        expect(checkFraming(null, imageWidth, imageHeight)).toEqual({ ok: false, reason: 'no-face' });
    });
});

describe('checkBrightness', () => {
    const makeImageData = (value, pixels = 100) => {
        const data = new Uint8ClampedArray(pixels * 4);
        for (let i = 0; i < data.length; i += 4) {
            data[i] = value; data[i + 1] = value; data[i + 2] = value; data[i + 3] = 255;
        }
        return data;
    };

    it('accepts a mid-brightness image', () => {
        expect(checkBrightness(makeImageData(128))).toEqual({ ok: true, reason: null });
    });

    it('rejects an overly dark image', () => {
        expect(checkBrightness(makeImageData(10))).toEqual({ ok: false, reason: 'too-dark' });
    });

    it('rejects an overly bright/blown-out image', () => {
        expect(checkBrightness(makeImageData(250))).toEqual({ ok: false, reason: 'too-bright' });
    });

    it('passes through when there is no image data to check', () => {
        expect(checkBrightness(null)).toEqual({ ok: true, reason: null });
    });
});

describe('checkOcclusion', () => {
    it('accepts a high detection confidence', () => {
        expect(checkOcclusion(0.9)).toEqual({ ok: true, reason: null });
    });

    it('rejects a low detection confidence', () => {
        expect(checkOcclusion(0.2)).toEqual({ ok: false, reason: 'low-confidence' });
    });

    it('passes through when no score is available', () => {
        expect(checkOcclusion(undefined)).toEqual({ ok: true, reason: null });
    });
});

describe('checkSingleFace', () => {
    it('accepts exactly one face', () => {
        expect(checkSingleFace(1)).toEqual({ ok: true, reason: null });
    });

    it('rejects zero faces', () => {
        expect(checkSingleFace(0)).toEqual({ ok: false, reason: 'no-face' });
    });

    it('rejects more than one face', () => {
        expect(checkSingleFace(2)).toEqual({ ok: false, reason: 'multiple-faces' });
    });
});
