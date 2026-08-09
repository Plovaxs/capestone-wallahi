import { describe, it, expect } from 'vitest';
import { calculateDistanceMeters, OFFICE_LOCATION, ALLOWED_RADIUS_METERS } from './officeGeofence';

describe('calculateDistanceMeters', () => {
    it('returns 0 for identical coordinates', () => {
        expect(calculateDistanceMeters(OFFICE_LOCATION.lat, OFFICE_LOCATION.lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng)).toBeCloseTo(0, 5);
    });

    it('returns a known real-world distance within tolerance (~111km per degree of latitude at the equator)', () => {
        // 1 degree of latitude is ~111.32km everywhere on Earth.
        const dist = calculateDistanceMeters(0, 0, 1, 0);
        expect(dist).toBeGreaterThan(110000);
        expect(dist).toBeLessThan(112000);
    });

    it('is symmetric (order of points does not matter)', () => {
        const a = calculateDistanceMeters(-6.2, 106.8, -6.21, 106.81);
        const b = calculateDistanceMeters(-6.21, 106.81, -6.2, 106.8);
        expect(a).toBeCloseTo(b, 6);
    });

    it('a point clearly outside ALLOWED_RADIUS_METERS from the office is measured as such', () => {
        // ~0.01 degrees is roughly 1.1km -- far outside a 100m radius.
        const dist = calculateDistanceMeters(OFFICE_LOCATION.lat + 0.01, OFFICE_LOCATION.lng, OFFICE_LOCATION.lat, OFFICE_LOCATION.lng);
        expect(dist).toBeGreaterThan(ALLOWED_RADIUS_METERS);
    });
});
