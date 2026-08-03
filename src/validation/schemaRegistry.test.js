import { describe, it, expect } from 'vitest';
import { validateForm, firstError } from './schemaRegistry';

describe('schemaRegistry: taskAssignment', () => {
    const validTask = {
        title: 'Write report',
        description: '',
        priority: 'Normal',
        due_date: '2026-06-20',
        assigned_to: ['user-1'],
    };

    it('accepts a valid task', () => {
        expect(validateForm('taskAssignment', validTask).success).toBe(true);
    });

    it('rejects a task with no title', () => {
        const result = validateForm('taskAssignment', { ...validTask, title: '' });
        expect(result.success).toBe(false);
        expect(result.errors.title).toBeTruthy();
    });

    it('rejects a task with no assignees', () => {
        const result = validateForm('taskAssignment', { ...validTask, assigned_to: [] });
        expect(result.success).toBe(false);
        expect(result.errors.assigned_to).toBeTruthy();
    });

    it('firstError returns null for valid data', () => {
        expect(firstError('taskAssignment', validTask)).toBeNull();
    });
});

describe('schemaRegistry: forumPost', () => {
    it('rejects an empty post body', () => {
        const result = validateForm('forumPost', { title: '', contribution: '', category: 'General Discussion' });
        expect(result.success).toBe(false);
    });

    it('accepts a post with only a body (title optional)', () => {
        const result = validateForm('forumPost', { contribution: 'Hello world', category: 'General Discussion' });
        expect(result.success).toBe(true);
    });
});
