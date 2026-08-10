import { describe, it, expect } from 'vitest';
import { computeEngagementScore, computeEngagementScores } from './employeeEngagementScore';

const emp = { id: 'emp-1' };

function makeAttendance(count, presentCount) {
    return Array.from({ length: count }, (_, i) => ({
        employee_id: 'emp-1',
        date: `2026-01-${String(i + 1).padStart(2, '0')}`,
        status: i < presentCount ? 'Present' : 'Late',
        clock_in: '08:00:00',
    }));
}

describe('computeEngagementScore', () => {
    it('returns insufficientData category when no signals are available at all', () => {
        const result = computeEngagementScore(emp, { tasks: [], attendance: [], reviews: [] });
        expect(result.category).toBe('insufficientData');
        expect(result.compositeScore).toBe(null);
    });

    it('computes a high score for strong punctuality and task completion', () => {
        const tasks = [
            { id: 't1', assigned_to: ['emp-1'], status: 'Approved' },
            { id: 't2', assigned_to: ['emp-1'], status: 'Completed' },
        ];
        const attendance = makeAttendance(10, 10); // 100% punctuality
        const result = computeEngagementScore(emp, { tasks, attendance, reviews: [] });
        expect(result.category).toBe('thriving');
        expect(result.compositeScore).toBeGreaterThanOrEqual(80);
    });

    it('computes a low score for poor punctuality and task completion', () => {
        const tasks = [
            { id: 't1', assigned_to: ['emp-1'], status: 'To Do' },
            { id: 't2', assigned_to: ['emp-1'], status: 'In Progress' },
        ];
        const attendance = makeAttendance(10, 1); // 10% punctuality
        const result = computeEngagementScore(emp, { tasks, attendance, reviews: [] });
        expect(['attention', 'urgent']).toContain(result.category);
    });

    it('redistributes weight when a signal is missing (no reviews yet) rather than penalizing for it', () => {
        const tasks = [{ id: 't1', assigned_to: ['emp-1'], status: 'Approved' }];
        const attendance = makeAttendance(5, 5);
        const result = computeEngagementScore(emp, { tasks, attendance, reviews: [] });
        expect(result.compositeScore).not.toBe(null);
        expect(result.breakdown.reviewScore).toBe(null);
    });

    it('only counts tasks actually assigned to this employee', () => {
        const tasks = [
            { id: 't1', assigned_to: ['someone-else'], status: 'To Do' },
            { id: 't2', assigned_to: ['emp-1'], status: 'Approved' },
        ];
        const result = computeEngagementScore(emp, { tasks, attendance: [], reviews: [] });
        expect(result.breakdown.taskCompletionRate).toBe(100);
    });

    it('captures review trend (improving vs declining) between the two most recent reviews', () => {
        const reviews = [
            { employee_id: 'emp-1', final_score: 60, created_at: '2026-01-01' },
            { employee_id: 'emp-1', final_score: 75, created_at: '2026-02-01' },
        ];
        const result = computeEngagementScore(emp, { tasks: [], attendance: [], reviews });
        expect(result.breakdown.reviewTrend).toBe(15);
    });

    it('applies a soft penalty for attendance anomalies without letting them dominate', () => {
        // A little natural variance in the normal days (needed for the
        // detector's MAD-based stats to have anything to compare against
        // -- 6 IDENTICAL clock-in times would give a MAD of exactly 0,
        // which detectAttendanceAnomalies correctly treats as "no
        // meaningful variance to judge an outlier against" and skips
        // entirely, silently making this test compare 0 anomalies against
        // 0 anomalies either way), plus one wildly anomalous day mixed in.
        const normalDays = ['08:00:00', '08:02:00', '07:58:00', '08:01:00', '07:59:00', '08:00:00'];
        const baseAttendance = normalDays.map((clock_in, i) => ({ employee_id: 'emp-1', date: `2026-01-${String(i + 1).padStart(2, '0')}`, status: 'Present', clock_in }));
        const attendanceWithOutlier = [...baseAttendance, { employee_id: 'emp-1', date: '2026-01-20', status: 'Present', clock_in: '15:00:00' }];
        const tasks = [{ id: 't1', assigned_to: ['emp-1'], status: 'Approved' }];
        const withAnomaly = computeEngagementScore(emp, { tasks, attendance: attendanceWithOutlier, reviews: [] });
        const withoutAnomaly = computeEngagementScore(emp, { tasks, attendance: baseAttendance, reviews: [] });
        expect(withAnomaly.breakdown.anomalyCount).toBeGreaterThan(0);
        expect(withAnomaly.compositeScore).toBeLessThan(withoutAnomaly.compositeScore);
    });
});

describe('computeEngagementScores', () => {
    it('sorts lowest score first, with insufficientData entries last', () => {
        const employees = [
            { id: 'strong' },
            { id: 'weak' },
            { id: 'no-data' },
        ];
        const tasks = [
            { id: 't1', assigned_to: ['strong'], status: 'Approved' },
            { id: 't2', assigned_to: ['weak'], status: 'To Do' },
        ];
        const attendance = [
            ...makeAttendance(5, 5).map((r) => ({ ...r, employee_id: 'strong' })),
            ...makeAttendance(5, 1).map((r) => ({ ...r, employee_id: 'weak' })),
        ];
        const results = computeEngagementScores(employees, { tasks, attendance, reviews: [] });
        expect(results[0].employeeId).toBe('weak');
        expect(results[results.length - 1].employeeId).toBe('no-data');
    });
});
