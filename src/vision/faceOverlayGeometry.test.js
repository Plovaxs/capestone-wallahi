import { describe, it, expect } from 'vitest';
import { calculateFaceOverlayStyle } from './faceOverlayGeometry';

describe('calculateFaceOverlayStyle', () => {
    it('returns null when the box or video element is missing', () => {
        expect(calculateFaceOverlayStyle({ box: null, videoEl: {} })).toBeNull();
        expect(calculateFaceOverlayStyle({ box: {}, videoEl: null })).toBeNull();
    });

    it('returns null when the video has no measurable dimensions yet', () => {
        const box = { x: 10, y: 10, width: 50, height: 50, imageWidth: 640, imageHeight: 480 };
        const videoEl = { videoWidth: 0, videoHeight: 0, clientWidth: 0, clientHeight: 0 };
        expect(calculateFaceOverlayStyle({ box, videoEl })).toBeNull();
    });

    it('scales and mirrors a box 1:1 when video and viewport are the same size (square)', () => {
        const box = { x: 0, y: 0, width: 100, height: 100 };
        const videoEl = { videoWidth: 400, videoHeight: 400, clientWidth: 400, clientHeight: 400 };
        const style = calculateFaceOverlayStyle({ box, videoEl });

        expect(style.width).toBe('100px');
        expect(style.height).toBe('100px');
        expect(style.top).toBe('0px');
        // Mirrored: a box at the left edge (x=0) lands at the right edge once flipped.
        expect(style.left).toBe('300px'); // viewportWidth(400) - standardLeft(0) - boxWidth(100)
    });

    it('centers letterboxed offset when the viewport is wider than the video (object-cover crop on Y)', () => {
        // Video is a 1:1 square (200x200), viewport is a wide rectangle (400x200) --
        // object-cover fills width, no vertical crop needed here since ratio check picks height-fill.
        const box = { x: 0, y: 0, width: 200, height: 200 };
        const videoEl = { videoWidth: 200, videoHeight: 200, clientWidth: 400, clientHeight: 200 };
        const style = calculateFaceOverlayStyle({ box, videoEl });

        // viewportRatio(2) > naturalRatio(1) -> fills height, centers horizontally.
        expect(style.height).toBe('200px');
        expect(style.width).toBe('200px');
        expect(style.top).toBe('0px');
    });

    it('falls back to the box-provided imageWidth/imageHeight when the video has no natural size', () => {
        const box = { x: 10, y: 10, width: 20, height: 20, imageWidth: 100, imageHeight: 100 };
        const videoEl = { videoWidth: 0, videoHeight: 0, clientWidth: 100, clientHeight: 100 };
        const style = calculateFaceOverlayStyle({ box, videoEl });

        expect(style).not.toBeNull();
        expect(style.width).toBe('20px');
    });
});
