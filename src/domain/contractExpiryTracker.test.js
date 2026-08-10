import { describe, it, expect } from 'vitest';
import { analyzeContractExpiry } from './contractExpiryTracker';

const TODAY = new Date('2026-08-10T00:00:00');

describe('analyzeContractExpiry', () => {
    it('classifies an already-expired contract', () => {
        const result = analyzeContractExpiry([{ id: '1', contract_end_date: '2026-08-01' }], { today: TODAY });
        expect(result[0].urgency).toBe('expired');
        expect(result[0].daysRemaining).toBeLessThan(0);
    });

    it('classifies a contract expiring within urgentDays', () => {
        const result = analyzeContractExpiry([{ id: '1', contract_end_date: '2026-08-15' }], { today: TODAY, urgentDays: 7 });
        expect(result[0].urgency).toBe('urgent');
        expect(result[0].daysRemaining).toBe(5);
    });

    it('classifies a contract expiring within warningDays but past urgentDays as warning', () => {
        const result = analyzeContractExpiry([{ id: '1', contract_end_date: '2026-08-30' }], { today: TODAY, warningDays: 30, urgentDays: 7 });
        expect(result[0].urgency).toBe('warning');
    });

    it('classifies a contract far in the future as ok', () => {
        const result = analyzeContractExpiry([{ id: '1', contract_end_date: '2027-01-01' }], { today: TODAY, warningDays: 30 });
        expect(result[0].urgency).toBe('ok');
    });

    it('classifies a contract expiring today as urgent (0 days remaining)', () => {
        const result = analyzeContractExpiry([{ id: '1', contract_end_date: '2026-08-10' }], { today: TODAY });
        expect(result[0].daysRemaining).toBe(0);
        expect(result[0].urgency).toBe('urgent');
    });

    it('skips employees with no contract_end_date', () => {
        const result = analyzeContractExpiry([{ id: '1' }, { id: '2', contract_end_date: null }], { today: TODAY });
        expect(result).toEqual([]);
    });

    it('sorts by soonest expiry first, mixing multiple employees', () => {
        const result = analyzeContractExpiry([
            { id: 'far', contract_end_date: '2027-01-01' },
            { id: 'expired', contract_end_date: '2026-07-01' },
            { id: 'soon', contract_end_date: '2026-08-12' },
        ], { today: TODAY });
        expect(result.map((r) => r.id)).toEqual(['expired', 'soon', 'far']);
    });

    it('returns an empty array for invalid input', () => {
        expect(analyzeContractExpiry(null)).toEqual([]);
        expect(analyzeContractExpiry(undefined)).toEqual([]);
    });
});
