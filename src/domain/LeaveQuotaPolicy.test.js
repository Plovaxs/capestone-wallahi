import { describe, it, expect } from 'vitest';
import { LeaveQuotaPolicy } from './LeaveQuotaPolicy';

describe('LeaveQuotaPolicy', () => {
    it('identifies quota-drawing leave types', () => {
        expect(LeaveQuotaPolicy.isQuotaType('Paid Holiday')).toBe(true);
        expect(LeaveQuotaPolicy.isQuotaType('Sick Leave')).toBe(true);
        expect(LeaveQuotaPolicy.isQuotaType('Unpaid Leave')).toBe(false);
    });

    it('maps leave type to the correct profile quota field', () => {
        expect(LeaveQuotaPolicy.quotaFieldFor('Sick Leave')).toBe('sick_days');
        expect(LeaveQuotaPolicy.quotaFieldFor('Paid Holiday')).toBe('vacation_days');
    });

    it('calculates requested days inclusive of both endpoints', () => {
        expect(LeaveQuotaPolicy.calculateRequestedDays('2026-01-01', '2026-01-01')).toBe(1);
        expect(LeaveQuotaPolicy.calculateRequestedDays('2026-01-01', '2026-01-05')).toBe(5);
    });

    it('calculates overage as zero when within quota', () => {
        expect(LeaveQuotaPolicy.calculateOverage(10, 5)).toBe(0);
    });

    it('calculates overage when request exceeds quota', () => {
        expect(LeaveQuotaPolicy.calculateOverage(3, 5)).toBe(2);
    });

    it('deducts requested days but never goes below zero', () => {
        expect(LeaveQuotaPolicy.deduct(5, 3)).toBe(2);
        expect(LeaveQuotaPolicy.deduct(3, 5)).toBe(0);
    });
});

describe('LeaveQuotaPolicy.calculateUnpaidLeaveUsedDays', () => {
    const emp = 'emp-1';
    const other = 'emp-2';

    it('sums Approved and Pending unpaid-leave days for this employee within the given year', () => {
        const requests = [
            { employee_id: emp, type: 'Unpaid Leave', status: 'Approved', start_date: '2026-01-01', end_date: '2026-01-03' }, // 3 days
            { employee_id: emp, type: 'Unpaid Leave', status: 'Pending', start_date: '2026-02-01', end_date: '2026-02-02' }, // 2 days
        ];
        expect(LeaveQuotaPolicy.calculateUnpaidLeaveUsedDays(requests, emp, new Date('2026-06-01'))).toBe(5);
    });

    it('ignores Denied unpaid-leave requests', () => {
        const requests = [
            { employee_id: emp, type: 'Unpaid Leave', status: 'Denied', start_date: '2026-01-01', end_date: '2026-01-10' },
        ];
        expect(LeaveQuotaPolicy.calculateUnpaidLeaveUsedDays(requests, emp, new Date('2026-06-01'))).toBe(0);
    });

    it('ignores other leave types and other employees', () => {
        const requests = [
            { employee_id: emp, type: 'Paid Holiday', status: 'Approved', start_date: '2026-01-01', end_date: '2026-01-05' },
            { employee_id: other, type: 'Unpaid Leave', status: 'Approved', start_date: '2026-01-01', end_date: '2026-01-05' },
        ];
        expect(LeaveQuotaPolicy.calculateUnpaidLeaveUsedDays(requests, emp, new Date('2026-06-01'))).toBe(0);
    });

    it('ignores unpaid leave from a different calendar year', () => {
        const requests = [
            { employee_id: emp, type: 'Unpaid Leave', status: 'Approved', start_date: '2025-12-01', end_date: '2025-12-05' },
        ];
        expect(LeaveQuotaPolicy.calculateUnpaidLeaveUsedDays(requests, emp, new Date('2026-06-01'))).toBe(0);
    });

    it('returns 0 for an empty or missing request list', () => {
        expect(LeaveQuotaPolicy.calculateUnpaidLeaveUsedDays([], emp)).toBe(0);
        expect(LeaveQuotaPolicy.calculateUnpaidLeaveUsedDays(undefined, emp)).toBe(0);
    });
});
