import { z } from 'zod';

/**
 * Centralized Zod schema registry — each form's shape is declared once
 * here instead of validated ad-hoc inline per view, so the same rule can't
 * silently drift between the places that need it.
 */
export const schemas = {
    leaveRequest: z.object({
        type: z.enum(['Paid Holiday', 'Sick Leave', 'Unpaid Leave']),
        start_date: z.string().min(1, 'Start date is required'),
        end_date: z.string().min(1, 'End date is required'),
        reason: z.string().max(500, 'Reason must be 500 characters or fewer').optional(),
    }),

    taskAssignment: z.object({
        title: z.string().min(1, 'Title is required').max(150, 'Title must be 150 characters or fewer'),
        description: z.string().max(2000, 'Description must be 2000 characters or fewer').optional(),
        priority: z.enum(['High', 'Normal', 'Low']),
        due_date: z.string().min(1, 'Due date is required'),
        assigned_to: z.array(z.string()).min(1, 'Select at least one assignee'),
    }),

    forumPost: z.object({
        title: z.string().max(150, 'Title must be 150 characters or fewer').optional(),
        contribution: z.string().min(1, 'Post cannot be empty').max(2000, 'Post must be 2000 characters or fewer'),
        category: z.string().min(1),
    }),

    helpdeskTicket: z.object({
        title: z.string().min(1, 'Title is required'),
        contribution: z.string().min(1, 'Details are required'),
        category: z.string().min(1),
    }),
};

/**
 * Runs `data` against the named schema, returning a UI-friendly shape
 * instead of Zod's raw error tree — { success, errors: { field: message } }.
 */
export function validateForm(schemaName, data) {
    const schema = schemas[schemaName];
    const result = schema.safeParse(data);
    if (result.success) return { success: true, data: result.data, errors: {} };

    const errors = {};
    for (const issue of result.error.issues) {
        const key = issue.path.join('.') || '_form';
        if (!errors[key]) errors[key] = issue.message;
    }
    return { success: false, data: null, errors };
}

/** Convenience: returns the first error message, or null if valid. */
export function firstError(schemaName, data) {
    const { success, errors } = validateForm(schemaName, data);
    if (success) return null;
    return Object.values(errors)[0];
}
