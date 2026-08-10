import { describe, it, expect } from 'vitest';
import { isWeekend, isMandatoryAttendanceDay } from './attendanceDayPolicy';

describe('attendanceDayPolicy', () => {
    it('identifies Saturday and Sunday as weekend', () => {
        expect(isWeekend('2026-01-03')).toBe(true); // Saturday
        expect(isWeekend('2026-01-04')).toBe(true); // Sunday
    });

    it('identifies Monday through Friday as not weekend', () => {
        expect(isWeekend('2026-01-05')).toBe(false); // Monday
        expect(isWeekend('2026-01-09')).toBe(false); // Friday
    });

    it('treats a missing or unparseable date as mandatory (safe default)', () => {
        expect(isWeekend(undefined)).toBe(false);
        expect(isWeekend(null)).toBe(false);
        expect(isWeekend('not-a-date')).toBe(false);
    });

    it('isMandatoryAttendanceDay is the inverse of isWeekend', () => {
        expect(isMandatoryAttendanceDay('2026-01-05')).toBe(true);
        expect(isMandatoryAttendanceDay('2026-01-03')).toBe(false);
    });
});
