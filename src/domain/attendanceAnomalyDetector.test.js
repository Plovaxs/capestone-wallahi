import { describe, it, expect } from 'vitest';
import { detectAttendanceAnomalies } from './attendanceAnomalyDetector';

/** Builds N rows for one employee, all at the same clock_in time except any overrides passed per-index. */
function makeRows(employeeId, times) {
    return times.map((clock_in, i) => ({ employee_id: employeeId, date: `2026-01-${String(i + 1).padStart(2, '0')}`, clock_in }));
}

describe('detectAttendanceAnomalies', () => {
    it('returns nothing for an employee with fewer than minSampleSize records', () => {
        const rows = makeRows('emp-1', ['08:00:00', '08:05:00', '08:02:00']);
        expect(detectAttendanceAnomalies(rows, { minSampleSize: 5 })).toEqual([]);
    });

    it('does not flag a consistently-punctual employee (low variance, no outlier)', () => {
        const rows = makeRows('emp-1', ['08:00:00', '08:02:00', '07:58:00', '08:01:00', '07:59:00', '08:03:00']);
        expect(detectAttendanceAnomalies(rows)).toEqual([]);
    });

    it('flags a genuine outlier far from the employee\'s own routine', () => {
        // Normally clocks in ~08:00; one day at 14:00 is a huge deviation from their own pattern.
        const rows = makeRows('emp-1', ['08:00:00', '08:02:00', '07:58:00', '08:01:00', '07:59:00', '14:00:00']);
        const anomalies = detectAttendanceAnomalies(rows);
        expect(anomalies.length).toBe(1);
        expect(anomalies[0].clock_in).toBe('14:00:00');
        expect(Math.abs(anomalies[0].zScore)).toBeGreaterThan(3.5);
    });

    it('does not flag anyone in an employee who legitimately has high natural variance (shift worker)', () => {
        // Wide spread but no single value is a true statistical outlier relative to that spread.
        const rows = makeRows('emp-1', ['06:00:00', '10:00:00', '08:00:00', '12:00:00', '09:00:00', '07:00:00']);
        expect(detectAttendanceAnomalies(rows)).toEqual([]);
    });

    it('evaluates each employee against their OWN history independently', () => {
        const earlyBird = makeRows('early-bird', ['06:00:00', '06:02:00', '05:58:00', '06:01:00', '06:00:00']);
        const nightOwl = makeRows('night-owl', ['11:00:00', '11:02:00', '10:58:00', '11:01:00', '11:00:00']);
        // Neither is anomalous relative to their OWN pattern, even though
        // 06:00 vs 11:00 would look wildly different compared to each other.
        expect(detectAttendanceAnomalies([...earlyBird, ...nightOwl])).toEqual([]);
    });

    it('ignores rows with an unparseable or missing clock_in', () => {
        const rows = [
            { employee_id: 'emp-1', date: '2026-01-01', clock_in: null },
            { employee_id: 'emp-1', date: '2026-01-02', clock_in: undefined },
            ...makeRows('emp-1', ['08:00:00', '08:01:00', '07:59:00', '08:02:00', '07:58:00']),
        ];
        expect(detectAttendanceAnomalies(rows)).toEqual([]);
    });

    it('returns an empty array for empty/invalid input', () => {
        expect(detectAttendanceAnomalies([])).toEqual([]);
        expect(detectAttendanceAnomalies(null)).toEqual([]);
        expect(detectAttendanceAnomalies(undefined)).toEqual([]);
    });

    it('sorts results by severity (largest |zScore| first)', () => {
        const rows = [
            ...makeRows('emp-1', ['08:00:00', '08:01:00', '07:59:00', '08:00:00', '08:01:00', '09:00:00']), // mild-ish outlier
            ...makeRows('emp-2', ['08:00:00', '08:01:00', '07:59:00', '08:00:00', '08:01:00', '16:00:00']), // extreme outlier
        ];
        const anomalies = detectAttendanceAnomalies(rows);
        expect(anomalies.length).toBe(2);
        expect(Math.abs(anomalies[0].zScore)).toBeGreaterThanOrEqual(Math.abs(anomalies[1].zScore));
    });
});
