import { PunctualityPolicy } from './PunctualityPolicy';
import { detectAttendanceAnomalies } from './attendanceAnomalyDetector';

/**
 * Composite "who might benefit from a supportive check-in" signal, built
 * entirely from data this app already collects -- punctuality, task
 * completion rate, performance review trend, attendance anomaly
 * frequency. Inspired by enterprise HR platforms' (Workday, etc.)
 * people-analytics dashboards, but DELIBERATELY reframed: those products'
 * "predictive flight-risk" scoring has real, well-documented ethical
 * problems (see SHRM's reporting on it) -- surveillance framing, opaque
 * "will this person quit" predictions employees never see or can
 * contest, used punitively rather than supportively.
 *
 * This is not that. It's a transparent, explainable composite of metrics
 * already visible elsewhere in this app (nothing hidden or inferred),
 * framed around "might need a supportive conversation", supervisor-only,
 * and every score comes with the breakdown that produced it rather than
 * a black-box number.
 */
const CATEGORY_THRESHOLDS = { thriving: 80, steady: 60, attention: 40 };

/**
 * @param {object} employee
 * @param {object} data
 * @param {Array} data.tasks - all tasks (will be filtered to this employee's assignments)
 * @param {Array} data.attendance - all attendance rows (will be filtered to this employee)
 * @param {Array} data.reviews - all performance evaluations (will be filtered to this employee)
 */
export function computeEngagementScore(employee, { tasks = [], attendance = [], reviews = [] } = {}) {
    const employeeTasks = tasks.filter((t) => (t.assigned_to || []).includes(employee.id));
    const employeeAttendance = attendance.filter((a) => a.employee_id === employee.id);
    const employeeReviews = reviews
        .filter((r) => r.employee_id === employee.id)
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    const punctuality = PunctualityPolicy.calculate(employeeAttendance);

    const closedTasks = employeeTasks.filter((t) => ['Completed', 'Approved'].includes(t.status));
    const taskCompletionRate = employeeTasks.length > 0 ? (closedTasks.length / employeeTasks.length) * 100 : null;

    const latestReview = employeeReviews[employeeReviews.length - 1] || null;
    const reviewScore = latestReview ? latestReview.final_score : null;
    const previousReview = employeeReviews[employeeReviews.length - 2] || null;
    const reviewTrend = latestReview && previousReview ? latestReview.final_score - previousReview.final_score : null;

    const anomalyCount = detectAttendanceAnomalies(employeeAttendance).length;

    // Weighted average of whichever signals are actually available --
    // redistributes weight rather than penalizing a new employee for not
    // having enough history yet to have a review or many tasks.
    const signals = [
        { value: punctuality, weight: 0.35 },
        { value: taskCompletionRate, weight: 0.35 },
        { value: reviewScore, weight: 0.3 },
    ].filter((s) => s.value !== null);

    let compositeScore = null;
    if (signals.length > 0) {
        const totalWeight = signals.reduce((sum, s) => sum + s.weight, 0);
        compositeScore = signals.reduce((sum, s) => sum + s.value * (s.weight / totalWeight), 0);
        // Anomalies are a soft penalty, not a separate weighted signal --
        // a couple of flagged days shouldn't dominate an otherwise strong
        // record, but a persistent pattern should pull the score down.
        compositeScore = Math.max(0, compositeScore - Math.min(anomalyCount * 3, 20));
    }

    let category = 'insufficientData';
    if (compositeScore !== null) {
        if (compositeScore >= CATEGORY_THRESHOLDS.thriving) category = 'thriving';
        else if (compositeScore >= CATEGORY_THRESHOLDS.steady) category = 'steady';
        else if (compositeScore >= CATEGORY_THRESHOLDS.attention) category = 'attention';
        else category = 'urgent';
    }

    return {
        employeeId: employee.id,
        compositeScore: compositeScore !== null ? Math.round(compositeScore) : null,
        category,
        breakdown: { punctuality, taskCompletionRate: taskCompletionRate !== null ? Math.round(taskCompletionRate) : null, reviewScore, reviewTrend, anomalyCount },
    };
}

/** Convenience batch version, sorted worst-first (lowest score / most in need of attention first, insufficientData last). */
export function computeEngagementScores(employees, data) {
    return employees
        .map((emp) => computeEngagementScore(emp, data))
        .sort((a, b) => {
            if (a.compositeScore === null && b.compositeScore === null) return 0;
            if (a.compositeScore === null) return 1;
            if (b.compositeScore === null) return -1;
            return a.compositeScore - b.compositeScore;
        });
}
