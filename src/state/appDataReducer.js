/**
 * Consolidates the 8 related "fetched from Supabase" entities (users,
 * tasks, attendance, leave, contributions, helpdesk, reviews,
 * notifications) into a single reducer instead of 8 independent
 * useState/setter pairs scattered across App.jsx's fetch functions.
 * Every action is a plain "replace this slice with fresh data" — the
 * actual merging/filtering logic stays in the fetch functions, this just
 * gives them one consistent way to commit the result.
 */
export const initialAppDataState = {
    allUsers: [],
    tasks: [],
    taskSubmissions: [],
    attendance: [],
    leaveRequests: [],
    contributions: [],
    helpdeskTickets: [],
    reviews: [],
    notifications: [],
};

export function appDataReducer(state, action) {
    switch (action.type) {
        case 'SET_ALL_USERS':
            return { ...state, allUsers: action.payload };
        case 'SET_TASKS':
            return { ...state, tasks: action.payload };
        case 'SET_TASK_SUBMISSIONS':
            return { ...state, taskSubmissions: action.payload };
        case 'SET_ATTENDANCE':
            return { ...state, attendance: action.payload };
        case 'SET_LEAVE_REQUESTS':
            return { ...state, leaveRequests: action.payload };
        case 'SET_CONTRIBUTIONS':
            return { ...state, contributions: action.payload };
        case 'SET_HELPDESK_TICKETS':
            return { ...state, helpdeskTickets: action.payload };
        case 'SET_REVIEWS':
            return { ...state, reviews: action.payload };
        case 'SET_NOTIFICATIONS':
            return { ...state, notifications: action.payload };
        default:
            throw new Error(`Unknown appDataReducer action: ${action.type}`);
    }
}
