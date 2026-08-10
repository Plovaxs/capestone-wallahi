import { computeEngagementScores } from './employeeEngagementScore';

/**
 * Pearson correlation coefficient between two equal-length numeric
 * arrays. Returns null when there isn't enough variance/data to compute
 * a meaningful value (fewer than 3 pairs, or either series has zero
 * variance -- a constant series can't meaningfully correlate with
 * anything, and dividing by a zero standard deviation would produce
 * NaN/Infinity).
 */
export function pearsonCorrelation(xs, ys) {
    if (xs.length !== ys.length || xs.length < 3) return null;
    const n = xs.length;
    const meanX = xs.reduce((a, b) => a + b, 0) / n;
    const meanY = ys.reduce((a, b) => a + b, 0) / n;

    let cov = 0;
    let varX = 0;
    let varY = 0;
    for (let i = 0; i < n; i++) {
        const dx = xs[i] - meanX;
        const dy = ys[i] - meanY;
        cov += dx * dy;
        varX += dx * dx;
        varY += dy * dy;
    }
    if (varX === 0 || varY === 0) return null;
    return cov / Math.sqrt(varX * varY);
}

/**
 * Cross-references attendance punctuality, task completion rate, and
 * performance review scores per employee -- reusing the same per-employee
 * breakdown already computed for the Employee Engagement Signal widget,
 * rather than recomputing it independently and risking the two drifting
 * apart. Surfaces both the raw scatter points (for charting) and the
 * Pearson correlation coefficient for each metric pair, so a supervisor
 * can see e.g. "does punctuality actually track with task completion
 * here, or not."
 */
export function computeCorrelationInsights(employees, data) {
    const scores = computeEngagementScores(employees, data);

    const points = scores.map((s) => ({
        employeeId: s.employeeId,
        punctuality: s.breakdown.punctuality,
        taskCompletionRate: s.breakdown.taskCompletionRate,
        reviewScore: s.breakdown.reviewScore,
    }));

    const pairsFor = (keyA, keyB) => {
        const filtered = points.filter((p) => p[keyA] !== null && p[keyB] !== null);
        return {
            points: filtered,
            correlation: pearsonCorrelation(filtered.map((p) => p[keyA]), filtered.map((p) => p[keyB])),
        };
    };

    return {
        punctualityVsTaskCompletion: pairsFor('punctuality', 'taskCompletionRate'),
        punctualityVsReviewScore: pairsFor('punctuality', 'reviewScore'),
        taskCompletionVsReviewScore: pairsFor('taskCompletionRate', 'reviewScore'),
    };
}
