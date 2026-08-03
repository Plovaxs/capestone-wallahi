import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskDeadlinePolicy } from './TaskDeadlinePolicy';

describe('TaskDeadlinePolicy', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-06-15T00:00:00'));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('treats Approved/Completed tasks as Safe regardless of due date', () => {
        expect(TaskDeadlinePolicy.getStatus('2026-01-01', 'Approved')).toBe('Safe');
        expect(TaskDeadlinePolicy.getStatus('2026-01-01', 'Completed')).toBe('Safe');
    });

    it('returns Normal when there is no due date', () => {
        expect(TaskDeadlinePolicy.getStatus(null, 'In Progress')).toBe('Normal');
    });

    it('flags a past due date as Overdue', () => {
        expect(TaskDeadlinePolicy.getStatus('2026-06-10', 'In Progress')).toBe('Overdue');
    });

    it('flags a due date within 2 days as Near Deadline', () => {
        expect(TaskDeadlinePolicy.getStatus('2026-06-16', 'In Progress')).toBe('Near Deadline');
        expect(TaskDeadlinePolicy.getStatus('2026-06-17', 'In Progress')).toBe('Near Deadline');
    });

    it('returns Normal for a due date further out', () => {
        expect(TaskDeadlinePolicy.getStatus('2026-06-25', 'In Progress')).toBe('Normal');
    });
});
