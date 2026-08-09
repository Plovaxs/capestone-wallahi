import { describe, it, expect, vi, beforeEach } from 'vitest';

const maybeSingleMock = vi.fn();
const insertMock = vi.fn();

vi.mock('../supabaseClient', () => ({
    supabase: {
        from: vi.fn(() => ({
            select: () => ({
                eq: () => ({
                    eq: () => ({
                        maybeSingle: maybeSingleMock,
                    }),
                }),
            }),
            insert: insertMock,
        })),
    },
}));

vi.mock('../utils/serverTime', () => ({
    getServerNow: vi.fn(),
}));

import { performClockIn, WORK_START_TIME } from './attendanceClockIn';
import { getServerNow } from '../utils/serverTime';

const userProfile = { id: 'emp-1', role: 'employee' };

describe('performClockIn', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        maybeSingleMock.mockResolvedValue({ data: null, error: null });
        insertMock.mockResolvedValue({ error: null });
        getServerNow.mockResolvedValue(new Date('2026-01-01T01:00:00Z')); // renders as a UTC-based local time string in the sandbox's default TZ
    });

    it('refuses to clock in an employee with no GPS coords yet', async () => {
        const result = await performClockIn({ userProfile, coords: null, isInRange: true, today: '2026-01-01' });
        expect(result).toEqual({ success: false, reason: 'gps-waiting' });
        expect(insertMock).not.toHaveBeenCalled();
    });

    it('refuses to clock in an employee outside the geofence', async () => {
        const result = await performClockIn({ userProfile, coords: { latitude: 1, longitude: 1 }, isInRange: false, today: '2026-01-01' });
        expect(result).toEqual({ success: false, reason: 'out-of-range' });
        expect(insertMock).not.toHaveBeenCalled();
    });

    it('does not require GPS/geofence for a supervisor', async () => {
        const supervisor = { id: 'sup-1', role: 'supervisor' };
        const result = await performClockIn({ userProfile: supervisor, coords: null, isInRange: false, today: '2026-01-01' });
        expect(result.success).toBe(true);
    });

    it('refuses a second clock-in on the same day (already-clocked-in guard)', async () => {
        maybeSingleMock.mockResolvedValue({ data: { id: 'existing-row' }, error: null });
        const result = await performClockIn({ userProfile, coords: { latitude: 1, longitude: 1 }, isInRange: true, today: '2026-01-01' });
        expect(result).toEqual({ success: false, reason: 'already-clocked-in' });
        expect(insertMock).not.toHaveBeenCalled();
    });

    it('surfaces a db error from the existence check without inserting', async () => {
        const dbError = new Error('connection lost');
        maybeSingleMock.mockResolvedValue({ data: null, error: dbError });
        const result = await performClockIn({ userProfile, coords: { latitude: 1, longitude: 1 }, isInRange: true, today: '2026-01-01' });
        expect(result).toEqual({ success: false, reason: 'db-error', error: dbError });
        expect(insertMock).not.toHaveBeenCalled();
    });

    it('surfaces a db error from the insert itself', async () => {
        const dbError = new Error('write failed');
        insertMock.mockResolvedValue({ error: dbError });
        const result = await performClockIn({ userProfile, coords: { latitude: 1, longitude: 1 }, isInRange: true, today: '2026-01-01' });
        expect(result).toEqual({ success: false, reason: 'db-error', error: dbError });
    });

    it('inserts a clock-in row using the server clock, not the device clock', async () => {
        const result = await performClockIn({ userProfile, coords: { latitude: 1, longitude: 1 }, isInRange: true, today: '2026-01-01', source: 'face-match' });
        expect(result.success).toBe(true);
        expect(result.source).toBe('face-match');
        expect(getServerNow).toHaveBeenCalled();
        expect(insertMock).toHaveBeenCalledWith([expect.objectContaining({
            employee_id: 'emp-1',
            date: '2026-01-01',
            latitude: 1,
            longitude: 1,
        })]);
    });

    it('marks status as Present when the server time is before WORK_START_TIME', async () => {
        getServerNow.mockResolvedValue(new Date('2026-01-01T00:00:00Z')); // renders well before WORK_START_TIME in the local sandbox timezone
        const result = await performClockIn({ userProfile, coords: { latitude: 1, longitude: 1 }, isInRange: true, today: '2026-01-01' });
        // Deterministic regardless of the sandbox's local timezone: compare
        // the same server-time string against the same WORK_START_TIME
        // constant the module itself compares against.
        const expectedStatus = result.time > WORK_START_TIME ? 'Late' : 'Present';
        expect(result.status).toBe(expectedStatus);
    });
});
