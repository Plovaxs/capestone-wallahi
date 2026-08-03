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
});
