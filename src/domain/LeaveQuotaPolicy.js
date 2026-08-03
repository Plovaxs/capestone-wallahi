/**
 * Pure business rules for the paid-leave quota system, extracted out of
 * LeaveView where the same calculation used to be copy-pasted three times
 * (single approval, bulk approval, supervisor allocation form). Framework
 * free — no React, no Supabase — so it can be unit-tested in isolation.
 */
export class LeaveQuotaPolicy {
    static isQuotaType(type) {
        return type === 'Paid Holiday' || type === 'Sick Leave';
    }

    static quotaFieldFor(type) {
        return type === 'Sick Leave' ? 'sick_days' : 'vacation_days';
    }

    static calculateRequestedDays(startDate, endDate) {
        const start = new Date(startDate);
        const end = new Date(endDate);
        return Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
    }

    static calculateOverage(currentDays, requestedDays) {
        return Math.max(0, requestedDays - currentDays);
    }

    static deduct(currentDays, requestedDays) {
        return Math.max(0, currentDays - requestedDays);
    }
}
