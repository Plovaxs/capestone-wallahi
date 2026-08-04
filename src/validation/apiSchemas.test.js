import { describe, it, expect } from 'vitest';
import { apiSchemas } from './apiSchemas';

describe('apiSchemas', () => {
    it('accepts a well-formed profiles.listAll response', () => {
        const result = apiSchemas['profiles.listAll'].safeParse([
            { id: '1', name: 'Rafi', role: 'employee', extraField: 'ignored-but-allowed' },
        ]);
        expect(result.success).toBe(true);
    });

    it('rejects a profiles.listAll response missing a required field', () => {
        const result = apiSchemas['profiles.listAll'].safeParse([{ id: '1', role: 'employee' }]); // missing name
        expect(result.success).toBe(false);
    });

    it('accepts a null profiles.getById response (profile not found)', () => {
        expect(apiSchemas['profiles.getById'].safeParse(null).success).toBe(true);
    });

    it('accepts extra/unknown fields on a task without failing (schema drift tolerance)', () => {
        const result = apiSchemas['tasks.listAll'].safeParse([
            { id: 1, title: 'Do the thing', status: 'To Do', some_brand_new_column: 'future-proof' },
        ]);
        expect(result.success).toBe(true);
    });

    it('rejects a task missing its status field', () => {
        const result = apiSchemas['tasks.listAll'].safeParse([{ id: 1, title: 'Do the thing' }]);
        expect(result.success).toBe(false);
    });
});
