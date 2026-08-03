import { RuleEngine } from './RuleEngine';

/**
 * Config-driven escalation policy for tasks — adding/tuning a rule here
 * doesn't require touching TasksView's rendering logic at all.
 */
export const taskEscalationRules = new RuleEngine([
    {
        id: 'overdue-high-priority',
        when: {
            all: [
                { fact: 'deadlineStatus', operator: 'equals', value: 'Overdue' },
                { fact: 'priority', operator: 'equals', value: 'High' },
            ],
        },
        then: { action: 'escalate', severity: 'critical' },
    },
    {
        id: 'overdue-any-priority',
        when: { fact: 'deadlineStatus', operator: 'equals', value: 'Overdue' },
        then: { action: 'escalate', severity: 'warning' },
    },
    {
        id: 'near-deadline-high-priority',
        when: {
            all: [
                { fact: 'deadlineStatus', operator: 'equals', value: 'Near Deadline' },
                { fact: 'priority', operator: 'equals', value: 'High' },
            ],
        },
        then: { action: 'flag', severity: 'notice' },
    },
]);

const SEVERITY_RANK = { critical: 3, warning: 2, notice: 1 };

/** Returns the highest-severity matching escalation for a task, or null if none apply. */
export function evaluateTaskEscalation(task, deadlineStatus) {
    const facts = { deadlineStatus, priority: task.priority, status: task.status };
    const matches = taskEscalationRules.run(facts);
    if (matches.length === 0) return null;
    return matches.reduce((best, current) =>
        SEVERITY_RANK[current.action.severity] > SEVERITY_RANK[best.action.severity] ? current : best
    );
}
