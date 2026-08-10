import { describe, it, expect } from 'vitest';
import { encodeBadgePayload, decodeBadgePayload } from './employeeBadge';

describe('employeeBadge', () => {
    it('round-trips a profile through encode/decode', () => {
        const profile = { id: 'abc-123', name: 'Alice' };
        const decoded = decodeBadgePayload(encodeBadgePayload(profile));
        expect(decoded).toEqual({ id: 'abc-123', name: 'Alice' });
    });

    it('rejects garbage input instead of throwing', () => {
        expect(decodeBadgePayload('not json at all')).toBe(null);
        expect(decodeBadgePayload('{"foo":"bar"}')).toBe(null);
        expect(decodeBadgePayload('{"v":1}')).toBe(null);
    });

    it('rejects a payload from a mismatched badge version', () => {
        expect(decodeBadgePayload(JSON.stringify({ v: 99, id: 'x' }))).toBe(null);
    });
});
