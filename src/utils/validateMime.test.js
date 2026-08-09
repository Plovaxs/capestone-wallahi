import { describe, it, expect } from 'vitest';
import { validateLoaFile } from './validateMime';

function makeFile(type, sizeBytes) {
    return { type, size: sizeBytes };
}

describe('validateLoaFile', () => {
    it('accepts a PDF under the size limit', () => {
        expect(validateLoaFile(makeFile('application/pdf', 1024 * 1024)).valid).toBe(true);
    });

    it('accepts a .doc file', () => {
        expect(validateLoaFile(makeFile('application/msword', 1024)).valid).toBe(true);
    });

    it('accepts a .docx file', () => {
        expect(validateLoaFile(makeFile('application/vnd.openxmlformats-officedocument.wordprocessingml.document', 1024)).valid).toBe(true);
    });

    it('rejects an image file', () => {
        const result = validateLoaFile(makeFile('image/png', 1024));
        expect(result.valid).toBe(false);
    });

    it('rejects a file over 10MB', () => {
        const result = validateLoaFile(makeFile('application/pdf', 11 * 1024 * 1024));
        expect(result.valid).toBe(false);
    });

    it('rejects a zero-size file', () => {
        const result = validateLoaFile(makeFile('application/pdf', 0));
        expect(result.valid).toBe(false);
    });
});
