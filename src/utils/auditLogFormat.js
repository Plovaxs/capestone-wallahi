// Shared plain-language formatting for audit_log rows -- extracted from
// AuditLogView.jsx (the original, supervisor-only "who did what" page) so
// SettingsView's personal "Recent Activity" card can render the exact same
// wording instead of drifting into a second, slightly different format.

export const ENTITY_ICONS = {
    task: '📋',
    leave_request: '🌴',
    performance_evaluation: '⭐',
    profile: '👤',
};

/** Turns one entry's jsonb `details` into a plain-language summary -- shape varies by entity_type/action (see the 4 trigger functions in migrations/20260810_document_audit_log.sql). */
export function describeAuditEntry(entry, t, getUserName) {
    const d = entry.details || {};
    switch (`${entry.entity_type}:${entry.action}`) {
        case 'task:status_change':
            return t('auditLog.descTaskStatusChange', { title: d.title || entry.entity_id, from: d.from, to: d.to });
        case 'leave_request:status_change':
            return t('auditLog.descLeaveStatusChange', { type: d.type, from: d.from, to: d.to });
        case 'performance_evaluation:created':
            return t('auditLog.descEvaluationCreated', { employee: getUserName(d.employee_id), score: d.final_score });
        case 'performance_evaluation:updated':
            return t('auditLog.descEvaluationUpdated', { employee: getUserName(d.employee_id), from: d.from_score, to: d.to_score });
        case 'performance_evaluation:deleted':
            return t('auditLog.descEvaluationDeleted', { employee: getUserName(d.employee_id), score: d.final_score });
        case 'profile:role_change':
            return t('auditLog.descRoleChange', { name: d.name, from: d.from, to: d.to });
        default:
            return `${entry.action} ${entry.entity_type}`;
    }
}

/**
 * "Why" line, shown BELOW the plain-language description -- rule/threshold
 * context captured AT THE MOMENT of an automated-adjacent decision (see
 * migrations/20260810_add_audit_explainability.sql). Returns null when
 * there's nothing to explain.
 */
export function explainAuditEntry(entry, t) {
    const d = entry.details || {};
    if (entry.entity_type === 'leave_request' && entry.action === 'status_change') {
        if (d.requested_days == null) return null;
        if (d.quota_balance_at_decision != null) {
            return t('auditLog.explainLeaveWithQuota', { days: d.requested_days, balance: d.quota_balance_at_decision });
        }
        return t('auditLog.explainLeaveNoQuota', { days: d.requested_days });
    }
    if (entry.entity_type === 'task' && entry.action === 'status_change') {
        if (d.days_relative_to_deadline == null) return null;
        if (d.days_relative_to_deadline > 0) return t('auditLog.explainTaskLate', { days: d.days_relative_to_deadline });
        if (d.days_relative_to_deadline < 0) return t('auditLog.explainTaskEarly', { days: Math.abs(d.days_relative_to_deadline) });
        return t('auditLog.explainTaskOnDeadline');
    }
    return null;
}
