import { describe, it, expect } from 'vitest';
import { analyzeOnboardingCompletion } from './onboardingCompletionTracker';

describe('analyzeOnboardingCompletion', () => {
    it('marks an employee 100% complete when every checklist item is present', () => {
        const employees = [{
            id: 'e1', name: 'Alice', position: 'Intern', department: 'IT', source: 'Uni X',
            contract_start_date: '2026-01-01', contract_end_date: '2026-06-01', loa_file_path: 'e1/loa.pdf',
        }];
        const attendance = [{ employee_id: 'e1' }];
        const [result] = analyzeOnboardingCompletion(employees, attendance);
        expect(result.percent).toBe(100);
        expect(result.isComplete).toBe(true);
    });

    it('flags missing fields and computes a partial percentage', () => {
        const employees = [{ id: 'e2', name: 'Bob', position: 'Intern' }];
        const [result] = analyzeOnboardingCompletion(employees, []);
        expect(result.isComplete).toBe(false);
        expect(result.items.find((i) => i.label === 'position').complete).toBe(true);
        expect(result.items.find((i) => i.label === 'department').complete).toBe(false);
        expect(result.items.find((i) => i.label === 'firstClockIn').complete).toBe(false);
    });

    it('requires both contract dates to count contractDates as complete', () => {
        const employees = [{ id: 'e3', name: 'Cara', contract_start_date: '2026-01-01' }];
        const [result] = analyzeOnboardingCompletion(employees, []);
        expect(result.items.find((i) => i.label === 'contractDates').complete).toBe(false);
    });

    it('sorts least-complete employees first', () => {
        const employees = [
            { id: 'full', name: 'Full', position: 'a', department: 'b', source: 'c', contract_start_date: '2026-01-01', contract_end_date: '2026-06-01', loa_file_path: 'x' },
            { id: 'empty', name: 'Empty' },
        ];
        const results = analyzeOnboardingCompletion(employees, [{ employee_id: 'full' }]);
        expect(results[0].id).toBe('empty');
        expect(results[results.length - 1].id).toBe('full');
    });
});
