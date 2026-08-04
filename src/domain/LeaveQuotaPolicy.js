/**
 * Pure business rules for the paid-leave quota system, extracted out of
 * LeaveView where the same calculation used to be copy-pasted three times
 * (single approval, bulk approval, supervisor allocation form). Framework
 * free — no React, no Supabase — so it can be unit-tested in isolation.
 */
export class LeaveQuotaPolicy {
    // 🟩 BUG FIX: "Unpaid Leave" deliberately never drew from the
    // vacation_days/sick_days profile balance (that's what "unpaid" means)
    // — but that also meant it had literally no cap at all. An intern could
    // submit an unlimited number/length of unpaid leave requests with zero
    // guardrail beyond a supervisor eventually noticing. This gives it its
    // own annual cap, checked against a rolling sum of the employee's own
    // Unpaid Leave requests already on file — no new database column,
    // since it's derived entirely from leave_requests rows already loaded.
    static UNPAID_LEAVE_ANNUAL_CAP_DAYS = 12;

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

    /**
     * Sums an employee's own Unpaid Leave requests within the same
     * calendar year as `referenceDate`. Counts Pending as well as Approved
     * — a pending request is provisionally holding those days, and letting
     * someone stack multiple pending unpaid-leave requests past the cap
     * while waiting on approval would defeat the guard entirely.
     */
    static calculateUnpaidLeaveUsedDays(leaveRequests, employeeId, referenceDate = new Date()) {
        const year = referenceDate.getFullYear();
        return (leaveRequests || [])
            .filter((req) =>
                req.employee_id === employeeId &&
                req.type === 'Unpaid Leave' &&
                (req.status === 'Approved' || req.status === 'Pending') &&
                new Date(req.start_date).getFullYear() === year
            )
            .reduce((sum, req) => sum + LeaveQuotaPolicy.calculateRequestedDays(req.start_date, req.end_date), 0);
    }
}
