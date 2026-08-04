import { describe, it, expect, beforeEach } from 'vitest';
import { saveEnrollmentProgress, loadEnrollmentProgress, clearEnrollmentProgress } from './enrollmentProgress';

describe('enrollmentProgress', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    it('round-trips saved progress for a user', () => {
        saveEnrollmentProgress('user-1', 2, [[0.1, 0.2], [0.3, 0.4]]);
        const loaded = loadEnrollmentProgress('user-1');
        expect(loaded).toEqual({ stepIndex: 2, captures: [[0.1, 0.2], [0.3, 0.4]] });
    });

    it('returns null when nothing is saved for that user', () => {
        expect(loadEnrollmentProgress('nobody')).toBeNull();
    });

    it('keeps different users isolated', () => {
        saveEnrollmentProgress('user-1', 1, [[0.1]]);
        saveEnrollmentProgress('user-2', 3, [[0.1], [0.2], [0.3]]);
        expect(loadEnrollmentProgress('user-1').stepIndex).toBe(1);
        expect(loadEnrollmentProgress('user-2').stepIndex).toBe(3);
    });

    it('discards corrupted/tampered entries instead of crashing', () => {
        localStorage.setItem('face_enrollment_wizard_progress_user-1', 'not json');
        expect(loadEnrollmentProgress('user-1')).toBeNull();
    });

    it('discards entries where stepIndex disagrees with capture count', () => {
        localStorage.setItem('face_enrollment_wizard_progress_user-1', JSON.stringify({ stepIndex: 5, captures: [[0.1]] }));
        expect(loadEnrollmentProgress('user-1')).toBeNull();
    });

    it('clears progress for a user without affecting others', () => {
        saveEnrollmentProgress('user-1', 1, [[0.1]]);
        saveEnrollmentProgress('user-2', 1, [[0.2]]);
        clearEnrollmentProgress('user-1');
        expect(loadEnrollmentProgress('user-1')).toBeNull();
        expect(loadEnrollmentProgress('user-2')).not.toBeNull();
    });
});
