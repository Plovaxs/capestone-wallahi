import { describe, it, expect } from 'vitest';
import { PunctualityPolicy } from './PunctualityPolicy';

describe('PunctualityPolicy', () => {
    it('returns null when there is no attendance history', () => {
        expect(PunctualityPolicy.calculate([])).toBeNull();
    });

    it('calculates a rounded percentage of Present days', () => {
        const rows = [
            { status: 'Present' },
            { status: 'Present' },
            { status: 'Late' },
        ];
        expect(PunctualityPolicy.calculate(rows)).toBe(67);
    });

    it('returns 100 when every record is Present', () => {
        expect(PunctualityPolicy.calculate([{ status: 'Present' }, { status: 'Present' }])).toBe(100);
    });

    it('returns 0 when no record is Present', () => {
        expect(PunctualityPolicy.calculate([{ status: 'Late' }, { status: 'Absent' }])).toBe(0);
    });

    it('excludes weekend rows from the calculation -- optional attendance should not move the score', () => {
        const rows = [
            { status: 'Present', date: '2026-01-05' }, // Monday
            { status: 'Present', date: '2026-01-06' }, // Tuesday
            { status: 'Late', date: '2026-01-03' },    // Saturday -- excluded
            { status: 'Late', date: '2026-01-04' },    // Sunday -- excluded
        ];
        expect(PunctualityPolicy.calculate(rows)).toBe(100);
    });

    it('returns null when only weekend (optional) rows exist', () => {
        const rows = [{ status: 'Present', date: '2026-01-03' }, { status: 'Late', date: '2026-01-04' }];
        expect(PunctualityPolicy.calculate(rows)).toBeNull();
    });
});
