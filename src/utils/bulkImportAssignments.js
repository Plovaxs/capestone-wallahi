import { parseCsv } from './parseCsv';

const FIELD_MAP = {
    institution: 'source',
    source: 'source',
    position: 'position',
    department: 'department',
    job_desk: 'job_desk',
    jobdesk: 'job_desk',
    work_mode: 'work_mode',
    duty_mode: 'work_mode',
    contract_start_date: 'contract_start_date',
    contract_start: 'contract_start_date',
    contract_end_date: 'contract_end_date',
    contract_end: 'contract_end_date',
};

// 🟩 SECURITY: every other work_mode check in the app treats it as one of
// exactly 'WFO'/'WFH' (falling back to 'WFO' when missing) -- a raw CSV
// value like "Onsite" written straight through used to silently disable
// the geofence access-denied check for that employee (see AttendanceView.jsx),
// since only an exact 'WFO' string was ever treated as requiring it.
// Case/whitespace-insensitive so a human-typed roster CSV ("wfo", " WFH ")
// still matches; anything else is dropped rather than written unvalidated.
function normalizeWorkMode(value) {
    const normalized = value.trim().toUpperCase();
    return normalized === 'WFO' || normalized === 'WFH' ? normalized : null;
}

/**
 * Matches CSV rows (expects an "email" column plus any of the
 * assignment fields above) against already-registered employee profiles.
 * Deliberately does NOT create auth accounts or profiles from scratch --
 * this app has no client-side path to Supabase Auth admin APIs (that
 * would require exposing the service-role key to the browser, which is a
 * real security boundary, not a corner to cut). Instead this bulk-applies
 * institution/position/department/contract fields to employees who have
 * already self-registered, matched by email, so a supervisor can import a
 * roster from HR in one shot instead of editing each person by hand.
 *
 * @returns {{ patches: Array<{id: string, name: string, patch: object}>, unmatchedEmails: string[], skippedRows: number }}
 */
export function bulkImportAssignments(csvText, employeeUsers) {
    const rows = parseCsv(csvText);
    const byEmail = new Map(
        employeeUsers.filter((u) => u.email).map((u) => [u.email.trim().toLowerCase(), u])
    );

    const patches = [];
    const unmatchedEmails = [];
    let skippedRows = 0;

    rows.forEach((row) => {
        const email = (row.email || '').trim().toLowerCase();
        if (!email) { skippedRows++; return; }

        const profile = byEmail.get(email);
        if (!profile) { unmatchedEmails.push(email); return; }

        const patch = {};
        Object.entries(row).forEach(([key, value]) => {
            const field = FIELD_MAP[key];
            if (!field || value === '') return;
            if (field === 'work_mode') {
                const normalized = normalizeWorkMode(value);
                if (normalized) patch[field] = normalized;
                return;
            }
            patch[field] = value;
        });

        if (Object.keys(patch).length > 0) {
            patches.push({ id: profile.id, name: profile.name, patch });
        }
    });

    return { patches, unmatchedEmails, skippedRows };
}
