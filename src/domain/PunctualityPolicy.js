import { isMandatoryAttendanceDay } from './attendanceDayPolicy';

/**
 * Pure scoring rule shared by AttendanceView (personal stats) and
 * PerformanceReviewView (per-employee telemetry), which used to each carry
 * their own copy of this calculation.
 */
export class PunctualityPolicy {
    /**
     * Returns a 0-100 rounded score, or null when there's no mandatory
     * (weekday) attendance history to score. Weekend rows are excluded --
     * weekend attendance is optional, so it shouldn't move this number
     * either way. See domain/attendanceDayPolicy.js.
     */
    static calculate(attendanceRows) {
        const mandatoryRows = attendanceRows.filter((a) => isMandatoryAttendanceDay(a.date));
        const total = mandatoryRows.length;
        if (total === 0) return null;
        const onTime = mandatoryRows.filter((a) => a.status === 'Present').length;
        return Math.round((onTime / total) * 100);
    }
}
