import { describe, it, expect } from 'vitest';
import { detectImpossibleTravel } from './impossibleTravelDetector';

// Jakarta and London -- roughly 11,700 km apart.
const JAKARTA = { latitude: -6.2088, longitude: 106.8456 };
const LONDON = { latitude: 51.5072, longitude: -0.1276 };

describe('detectImpossibleTravel', () => {
    it('returns nothing when consecutive clock-ins are close together and plausible', () => {
        const rows = [
            { employee_id: 'e1', date: '2026-01-01', clock_in: '08:00:00', ...JAKARTA },
            { employee_id: 'e1', date: '2026-01-02', clock_in: '08:00:00', latitude: JAKARTA.latitude + 0.001, longitude: JAKARTA.longitude + 0.001 },
        ];
        expect(detectImpossibleTravel(rows)).toEqual([]);
    });

    it('flags a physically impossible jump between two clock-ins', () => {
        const rows = [
            { employee_id: 'e1', date: '2026-01-01', clock_in: '08:00:00', ...JAKARTA },
            { employee_id: 'e1', date: '2026-01-01', clock_in: '09:00:00', ...LONDON }, // ~11,700km in 1 hour
        ];
        const flags = detectImpossibleTravel(rows);
        expect(flags).toHaveLength(1);
        expect(flags[0].employee_id).toBe('e1');
        expect(flags[0].impliedSpeedKmh).toBeGreaterThan(900);
    });

    it('does not flag a long distance covered over a plausible amount of time (e.g. an overnight flight)', () => {
        const rows = [
            { employee_id: 'e1', date: '2026-01-01', clock_in: '08:00:00', ...JAKARTA },
            { employee_id: 'e1', date: '2026-01-03', clock_in: '08:00:00', ...LONDON }, // same distance, 48 hours later
        ];
        expect(detectImpossibleTravel(rows)).toEqual([]);
    });

    it('evaluates each employee independently', () => {
        const rows = [
            { employee_id: 'e1', date: '2026-01-01', clock_in: '08:00:00', ...JAKARTA },
            { employee_id: 'e1', date: '2026-01-02', clock_in: '08:00:00', latitude: JAKARTA.latitude + 0.001, longitude: JAKARTA.longitude + 0.001 },
            { employee_id: 'e2', date: '2026-01-01', clock_in: '08:00:00', ...JAKARTA },
            { employee_id: 'e2', date: '2026-01-01', clock_in: '09:00:00', ...LONDON },
        ];
        const flags = detectImpossibleTravel(rows);
        expect(flags).toHaveLength(1);
        expect(flags[0].employee_id).toBe('e2');
    });

    it('ignores rows with no coordinates (e.g. WFH clock-ins that never captured GPS)', () => {
        const rows = [
            { employee_id: 'e1', date: '2026-01-01', clock_in: '08:00:00', latitude: null, longitude: null },
            { employee_id: 'e1', date: '2026-01-02', clock_in: '08:00:00', latitude: null, longitude: null },
        ];
        expect(detectImpossibleTravel(rows)).toEqual([]);
    });

    it('ignores two rows recorded moments apart (avoids a divide-by-near-zero blowup on glitched data)', () => {
        const rows = [
            { employee_id: 'e1', date: '2026-01-01', clock_in: '08:00:00', ...JAKARTA },
            { employee_id: 'e1', date: '2026-01-01', clock_in: '08:00:05', ...LONDON },
        ];
        expect(detectImpossibleTravel(rows)).toEqual([]);
    });

    it('sorts flags worst (highest implied speed) first', () => {
        const rows = [
            { employee_id: 'e1', date: '2026-01-01', clock_in: '08:00:00', ...JAKARTA },
            { employee_id: 'e1', date: '2026-01-01', clock_in: '09:00:00', ...LONDON },
            { employee_id: 'e2', date: '2026-01-01', clock_in: '08:00:00', ...JAKARTA },
            { employee_id: 'e2', date: '2026-01-01', clock_in: '08:30:00', ...LONDON }, // same distance, half the time -> faster
        ];
        const flags = detectImpossibleTravel(rows);
        expect(flags).toHaveLength(2);
        expect(flags[0].employee_id).toBe('e2');
        expect(flags[0].impliedSpeedKmh).toBeGreaterThan(flags[1].impliedSpeedKmh);
    });

    it('returns an empty array for empty/invalid input', () => {
        expect(detectImpossibleTravel([])).toEqual([]);
        expect(detectImpossibleTravel(null)).toEqual([]);
        expect(detectImpossibleTravel(undefined)).toEqual([]);
    });
});
