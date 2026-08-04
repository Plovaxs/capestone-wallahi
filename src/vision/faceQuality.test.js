import { describe, it, expect } from 'vitest';
import { checkFraming, checkBrightness, checkOcclusion, checkSingleFace, checkLensObstruction } from './faceQuality';

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

    it('accepts multiple faces as long as none is flagged ambiguous (e.g. a bystander in the background)', () => {
        expect(checkSingleFace(3, false)).toEqual({ ok: true, reason: null });
    });

    it('rejects when a second face is flagged ambiguous (photo-next-to-face attack shape)', () => {
        expect(checkSingleFace(2, true)).toEqual({ ok: false, reason: 'multiple-faces' });
    });
});

describe('checkLensObstruction', () => {
    const width = 20;
    const height = 20;

    const makeFlatImageData = (value) => {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < data.length; i += 4) {
            data[i] = value; data[i + 1] = value; data[i + 2] = value; data[i + 3] = 255;
        }
        return data;
    };

    const makeCheckerboardImageData = () => {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const value = (x + y) % 2 === 0 ? 20 : 235;
                data[idx] = value; data[idx + 1] = value; data[idx + 2] = value; data[idx + 3] = 255;
            }
        }
        return data;
    };

    it('flags a perfectly uniform frame as a fogged/dirty/obstructed lens', () => {
        expect(checkLensObstruction(makeFlatImageData(128), width, height)).toEqual({ ok: false, reason: 'lens-obstructed' });
    });

    it('accepts a frame with real high-frequency detail', () => {
        expect(checkLensObstruction(makeCheckerboardImageData(), width, height)).toEqual({ ok: true, reason: null });
    });

    it('passes through when there is no image data to check', () => {
        expect(checkLensObstruction(null, width, height)).toEqual({ ok: true, reason: null });
    });

    it('a dim-but-detailed frame is not flagged as lens obstruction (dark != obstructed)', () => {
        const data = new Uint8ClampedArray(width * height * 4);
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const value = (x + y) % 2 === 0 ? 5 : 45;
                data[idx] = value; data[idx + 1] = value; data[idx + 2] = value; data[idx + 3] = 255;
            }
        }
        expect(checkLensObstruction(data, width, height)).toEqual({ ok: true, reason: null });
    });
});
