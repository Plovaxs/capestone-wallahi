import { describe, it, expect } from 'vitest';
import { bulkImportAssignments } from './bulkImportAssignments';

const employeeUsers = [
    { id: 'u1', name: 'Alice', email: 'alice@example.com' },
    { id: 'u2', name: 'Bob', email: 'bob@example.com' },
];

describe('bulkImportAssignments', () => {
    it('matches rows to profiles by email (case-insensitive) and maps known columns', () => {
        const csv = 'email,institution,position,department,contract_start_date,contract_end_date\nALICE@example.com,President University,Backend Intern,IT,2026-01-01,2026-06-01';
        const { patches, unmatchedEmails, skippedRows } = bulkImportAssignments(csv, employeeUsers);
        expect(patches).toHaveLength(1);
        expect(patches[0]).toMatchObject({
            id: 'u1',
            name: 'Alice',
            patch: {
                source: 'President University',
                position: 'Backend Intern',
                department: 'IT',
                contract_start_date: '2026-01-01',
                contract_end_date: '2026-06-01',
            },
        });
        expect(unmatchedEmails).toHaveLength(0);
        expect(skippedRows).toBe(0);
    });

    it('reports emails that do not match any existing employee profile', () => {
        const csv = 'email,position\nunknown@example.com,QA Intern';
        const { patches, unmatchedEmails } = bulkImportAssignments(csv, employeeUsers);
        expect(patches).toHaveLength(0);
        expect(unmatchedEmails).toEqual(['unknown@example.com']);
    });

    it('skips rows with no email and ignores empty-string values', () => {
        const csv = 'email,position\n,QA Intern\nbob@example.com,';
        const { patches, skippedRows } = bulkImportAssignments(csv, employeeUsers);
        expect(skippedRows).toBe(1);
        expect(patches).toHaveLength(0); // bob's row has no non-empty mapped fields
    });

    it('normalizes a valid work_mode value case/whitespace-insensitively', () => {
        const csv = 'email,work_mode\nbob@example.com, wfh ';
        const { patches } = bulkImportAssignments(csv, employeeUsers);
        expect(patches[0].patch.work_mode).toBe('WFH');
    });

    it('drops an unrecognized work_mode value instead of writing it unvalidated', () => {
        // 🟩 SECURITY REGRESSION: AttendanceView's geofence check only ever
        // required a location match for the exact string 'WFO' -- any other
        // value (like a garbage CSV import) silently skipped that check.
        const csv = 'email,work_mode,position\nbob@example.com,Onsite,QA Intern';
        const { patches } = bulkImportAssignments(csv, employeeUsers);
        expect(patches[0].patch.work_mode).toBeUndefined();
        expect(patches[0].patch.position).toBe('QA Intern');
    });

    it('handles quoted CSV fields containing commas', () => {
        const csv = 'email,job_desk\nbob@example.com,"Handles reports, tickets, and QA"';
        const { patches } = bulkImportAssignments(csv, employeeUsers);
        expect(patches[0].patch.job_desk).toBe('Handles reports, tickets, and QA');
    });
});
