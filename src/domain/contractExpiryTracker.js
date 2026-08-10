const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Contract/internship-period expiry analysis -- a genuinely pragmatic gap
 * for an outsourcing management platform: contract_start_date/
 * contract_end_date have been collected per employee since early in this
 * project (and are now mandatory at registration, see LoginPage.jsx), but
 * nothing ever surfaced "whose contract is about to run out" -- a
 * supervisor would only find out by manually checking each profile.
 *
 * Pure client-side computation over already-fetched employee data (no new
 * database objects needed) -- classifies each employee with a contract
 * end date into a distinct urgency tier and sorts by how soon it expires.
 *
 * @param {Array<{contract_end_date?: string}>} employees
 * @param {object} [options]
 * @param {Date} [options.today] - injectable for testing; defaults to the real current date
 * @param {number} [options.warningDays] - "expiring soon" cutoff
 * @param {number} [options.urgentDays] - "expiring very soon" cutoff (a tighter window within warningDays)
 */
export function analyzeContractExpiry(employees, { today = new Date(), warningDays = 30, urgentDays = 7 } = {}) {
    if (!Array.isArray(employees)) return [];

    const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());

    return employees
        .filter((e) => e && e.contract_end_date)
        .map((e) => {
            const end = new Date(e.contract_end_date);
            const endMidnight = new Date(end.getFullYear(), end.getMonth(), end.getDate());
            const daysRemaining = Math.round((endMidnight - todayMidnight) / DAY_MS);

            let urgency;
            if (daysRemaining < 0) urgency = 'expired';
            else if (daysRemaining <= urgentDays) urgency = 'urgent';
            else if (daysRemaining <= warningDays) urgency = 'warning';
            else urgency = 'ok';

            return { ...e, daysRemaining, urgency };
        })
        .sort((a, b) => a.daysRemaining - b.daysRemaining);
}
