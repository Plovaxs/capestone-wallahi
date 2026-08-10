/**
 * Onboarding-completion analysis: institution/position/department/
 * contract dates/LOA have been mandatory at registration for a while
 * (see LoginPage.jsx), but accounts created before that requirement (or
 * ones a supervisor bulk-imported/edited midway) can still be missing
 * pieces -- nothing ever surfaced "who still has an incomplete onboarding
 * checklist" in one place. Pure client-side over already-fetched
 * employees + attendance (no new database objects needed).
 *
 * @param {Array<object>} employees
 * @param {Array<{employee_id: string}>} [attendance] - used to check whether each employee has clocked in at least once
 */
export function analyzeOnboardingCompletion(employees, attendance = []) {
    if (!Array.isArray(employees)) return [];

    const employeesWithAttendance = new Set(attendance.map((a) => a.employee_id));

    return employees.map((emp) => {
        const items = [
            { label: 'position', complete: !!emp.position },
            { label: 'department', complete: !!emp.department },
            { label: 'institution', complete: !!emp.source },
            { label: 'contractDates', complete: !!emp.contract_start_date && !!emp.contract_end_date },
            { label: 'loaDocument', complete: !!emp.loa_file_path },
            { label: 'firstClockIn', complete: employeesWithAttendance.has(emp.id) },
        ];

        const completedCount = items.filter((i) => i.complete).length;
        const percent = Math.round((completedCount / items.length) * 100);

        return {
            id: emp.id,
            name: emp.name,
            items,
            percent,
            isComplete: percent === 100,
        };
    }).sort((a, b) => a.percent - b.percent);
}
