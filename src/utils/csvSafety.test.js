import { describe, it, expect } from 'vitest';
import { sanitizeCsvCell } from './csvSafety';

describe('sanitizeCsvCell', () => {
    it('prefixes a value starting with = to prevent formula execution', () => {
        expect(sanitizeCsvCell('=SUM(A1:A10)')).toBe("'=SUM(A1:A10)");
    });

    it('prefixes values starting with +, -, or @', () => {
        expect(sanitizeCsvCell('+1234')).toBe("'+1234");
        expect(sanitizeCsvCell('-1234')).toBe("'-1234");
        expect(sanitizeCsvCell('@mention')).toBe("'@mention");
    });

    it('leaves ordinary text untouched', () => {
        expect(sanitizeCsvCell('Finish the report')).toBe('Finish the report');
    });

    it('treats null/undefined as an empty string', () => {
        expect(sanitizeCsvCell(null)).toBe('');
        expect(sanitizeCsvCell(undefined)).toBe('');
    });

    it('coerces non-string values to string first', () => {
        expect(sanitizeCsvCell(42)).toBe('42');
    });
});
