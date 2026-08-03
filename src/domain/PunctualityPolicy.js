/**
 * Pure scoring rule shared by AttendanceView (personal stats) and
 * PerformanceReviewView (per-employee telemetry), which used to each carry
 * their own copy of this calculation.
 */
export class PunctualityPolicy {
    /** Returns a 0-100 rounded score, or null when there's no attendance history to score. */
    static calculate(attendanceRows) {
        const total = attendanceRows.length;
        if (total === 0) return null;
        const onTime = attendanceRows.filter((a) => a.status === 'Present').length;
        return Math.round((onTime / total) * 100);
    }
}
