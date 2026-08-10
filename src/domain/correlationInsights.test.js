import { describe, it, expect } from 'vitest';
import { pearsonCorrelation, computeCorrelationInsights } from './correlationInsights';

describe('pearsonCorrelation', () => {
    it('returns 1 for perfectly correlated series', () => {
        expect(pearsonCorrelation([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 5);
    });

    it('returns -1 for perfectly inversely correlated series', () => {
        expect(pearsonCorrelation([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 5);
    });

    it('returns null when there are fewer than 3 pairs', () => {
        expect(pearsonCorrelation([1, 2], [3, 4])).toBe(null);
    });

    it('returns null when a series has zero variance', () => {
        expect(pearsonCorrelation([5, 5, 5], [1, 2, 3])).toBe(null);
    });
});

describe('computeCorrelationInsights', () => {
    it('builds scatter points and a correlation coefficient for each metric pair', () => {
        const employees = [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }];
        const tasks = [
            { id: 't1', assigned_to: ['e1'], status: 'Approved' },
            { id: 't2', assigned_to: ['e2'], status: 'To Do' },
            { id: 't3', assigned_to: ['e3'], status: 'Approved' },
        ];
        const attendance = [
            { employee_id: 'e1', status: 'Present', clock_in: '08:00:00' },
            { employee_id: 'e2', status: 'Late', clock_in: '09:30:00' },
            { employee_id: 'e3', status: 'Present', clock_in: '08:05:00' },
        ];
        const result = computeCorrelationInsights(employees, { tasks, attendance, reviews: [] });
        expect(result.punctualityVsTaskCompletion.points.length).toBeGreaterThan(0);
        expect(typeof result.punctualityVsTaskCompletion.correlation === 'number' || result.punctualityVsTaskCompletion.correlation === null).toBe(true);
    });

    it('returns empty points when no employees have both signals present', () => {
        const employees = [{ id: 'e1' }];
        const result = computeCorrelationInsights(employees, { tasks: [], attendance: [], reviews: [] });
        expect(result.punctualityVsTaskCompletion.points).toEqual([]);
        expect(result.punctualityVsTaskCompletion.correlation).toBe(null);
    });
});
