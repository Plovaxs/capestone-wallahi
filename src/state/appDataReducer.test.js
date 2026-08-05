import { describe, it, expect } from 'vitest';
import { appDataReducer, initialAppDataState } from './appDataReducer';

describe('appDataReducer', () => {
    it('starts with empty arrays for every entity', () => {
        expect(initialAppDataState).toEqual({
            allUsers: [], tasks: [], taskSubmissions: [], attendance: [], leaveRequests: [],
            contributions: [], helpdeskTickets: [], reviews: [], notifications: [],
        });
    });

    it('SET_TASKS replaces only the tasks slice', () => {
        const state = { ...initialAppDataState, allUsers: ['u1'] };
        const next = appDataReducer(state, { type: 'SET_TASKS', payload: ['t1', 't2'] });
        expect(next.tasks).toEqual(['t1', 't2']);
        expect(next.allUsers).toEqual(['u1']); // untouched
    });

    it.each([
        ['SET_ALL_USERS', 'allUsers'],
        ['SET_TASK_SUBMISSIONS', 'taskSubmissions'],
        ['SET_ATTENDANCE', 'attendance'],
        ['SET_LEAVE_REQUESTS', 'leaveRequests'],
        ['SET_CONTRIBUTIONS', 'contributions'],
        ['SET_HELPDESK_TICKETS', 'helpdeskTickets'],
        ['SET_REVIEWS', 'reviews'],
        ['SET_NOTIFICATIONS', 'notifications'],
    ])('%s replaces the %s slice', (actionType, key) => {
        const next = appDataReducer(initialAppDataState, { type: actionType, payload: ['x'] });
        expect(next[key]).toEqual(['x']);
    });

    it('throws on an unknown action type', () => {
        expect(() => appDataReducer(initialAppDataState, { type: 'NOPE' })).toThrow();
    });
});
