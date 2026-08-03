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
