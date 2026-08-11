import { parseLocalDateOnly } from '../utils/dateOnly';

/**
 * Pure business rule, framework-free: given a task's due date and status,
 * decide its deadline urgency bucket. Lives outside React so it's testable
 * without rendering anything, and so the same rule can't silently drift
 * between the two views that used to each carry their own copy.
 */
export class TaskDeadlinePolicy {
    static getStatus(dueDate, status) {
        if (['Approved', 'Completed'].includes(status)) return 'Safe';
        if (!dueDate) return 'Normal';

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // 🟩 TIMEZONE FIX: `new Date(dueDate)` parses a plain "YYYY-MM-DD"
        // string as UTC midnight, which silently shifts the effective date
        // back a day for any user west of UTC. parseLocalDateOnly reads it
        // as LOCAL midnight directly, matching `today` above.
        const due = parseLocalDateOnly(dueDate);

        const diffDays = Math.ceil((due - today) / (1000 * 60 * 60 * 24));

        if (diffDays < 0) return 'Overdue';
        if (diffDays <= 2) return 'Near Deadline';
        return 'Normal';
    }
}
