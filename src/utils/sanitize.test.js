import { describe, it, expect } from 'vitest';
import { sanitizeLoaExtension } from './sanitize';

describe('sanitizeLoaExtension', () => {
    it('preserves an allowed extension, lowercased', () => {
        expect(sanitizeLoaExtension('Letter.PDF')).toBe('pdf');
        expect(sanitizeLoaExtension('assignment.doc')).toBe('doc');
        expect(sanitizeLoaExtension('assignment.docx')).toBe('docx');
    });

    it('falls back to "bin" for a disallowed or missing extension', () => {
        expect(sanitizeLoaExtension('script.exe')).toBe('bin');
        expect(sanitizeLoaExtension('noextension')).toBe('bin');
        expect(sanitizeLoaExtension('photo.jpg')).toBe('bin');
    });
});
