import { createMachine } from 'xstate';

/**
 * Formal state chart for a task's lifecycle — replaces scattered
 * if/else transition checks with an explicit, inspectable graph. Events
 * are named after their target status so the chart doubles as
 * documentation of exactly which status changes are legal from where.
 *
 * The Supabase row remains the single source of truth for a task's actual
 * status; this machine isn't run as live state, it's used as a guard
 * (`canTransitionTo`) that checks a proposed change against the graph
 * before it's committed.
 */
export const taskWorkflowMachine = createMachine({
    id: 'taskWorkflow',
    initial: 'To Do',
    states: {
        'To Do': { on: { 'In Progress': { target: 'In Progress' } } },
        'In Progress': {
            on: {
                'Completed': { target: 'Completed' },
                'Revision Needed': { target: 'Revision Needed' },
            },
        },
        'Revision Needed': { on: { 'Completed': { target: 'Completed' } } },
        'Completed': {
            on: {
                'Approved': { target: 'Approved' },
                'Revision Needed': { target: 'Revision Needed' },
            },
        },
        'Approved': { type: 'final' },
    },
});

/** Whether moving from `currentStatus` to `targetStatus` is a legal edge in the graph. */
export function canTransitionTo(currentStatus, targetStatus) {
    const stateNode = taskWorkflowMachine.config.states[currentStatus];
    return !!stateNode?.on?.[targetStatus];
}
