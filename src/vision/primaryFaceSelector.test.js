import { describe, it, expect } from 'vitest';
import { selectPrimaryFace } from './primaryFaceSelector';

const imageWidth = 640;
const imageHeight = 480;

describe('selectPrimaryFace', () => {
    it('returns null primary when there are no detections', () => {
        expect(selectPrimaryFace([], imageWidth, imageHeight)).toEqual({ primary: null, isAmbiguous: false });
    });

    it('returns the single detection unambiguously when only one face exists', () => {
        const det = { box: { x: 260, y: 180, width: 120, height: 120 } };
        const result = selectPrimaryFace([det], imageWidth, imageHeight);
        expect(result.primary).toBe(det);
        expect(result.isAmbiguous).toBe(false);
    });

    it('picks the larger, more central face as primary among a crowd', () => {
        const mainUser = { box: { x: 260, y: 180, width: 150, height: 150 } }; // centered, large
        const bystander = { box: { x: 10, y: 10, width: 30, height: 30 } }; // tiny, corner
        const result = selectPrimaryFace([bystander, mainUser], imageWidth, imageHeight);
        expect(result.primary).toBe(mainUser);
        expect(result.isAmbiguous).toBe(false);
    });

    it('does not flag ambiguous for a small distant bystander', () => {
        const mainUser = { box: { x: 260, y: 180, width: 150, height: 150 } };
        const bystander = { box: { x: 5, y: 5, width: 40, height: 40 } };
        const result = selectPrimaryFace([mainUser, bystander], imageWidth, imageHeight);
        expect(result.isAmbiguous).toBe(false);
    });

    it('flags ambiguous when a similarly-sized face sits right next to the primary (photo-next-to-face attack shape)', () => {
        const mainUser = { box: { x: 260, y: 180, width: 150, height: 150 } };
        const heldPhoto = { box: { x: 400, y: 180, width: 140, height: 140 } }; // similar size, adjacent
        const result = selectPrimaryFace([mainUser, heldPhoto], imageWidth, imageHeight);
        expect(result.isAmbiguous).toBe(true);
    });

    it('does not flag ambiguous when a similarly-sized face is far away', () => {
        const mainUser = { box: { x: 50, y: 180, width: 150, height: 150 } };
        const otherPerson = { box: { x: 500, y: 180, width: 145, height: 145 } }; // similar size, far apart
        const result = selectPrimaryFace([mainUser, otherPerson], imageWidth, imageHeight);
        expect(result.isAmbiguous).toBe(false);
    });
});
