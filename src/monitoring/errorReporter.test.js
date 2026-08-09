import { describe, it, expect, vi, beforeEach } from 'vitest';

const getSessionMock = vi.fn();
const insertMock = vi.fn();

vi.mock('../supabaseClient', () => ({
    supabase: { auth: { getSession: (...args) => getSessionMock(...args) } },
}));

vi.mock('../data/repositories/clientErrorLogsRepository', () => ({
    clientErrorLogsRepository: { insert: (...args) => insertMock(...args) },
}));

// The module keeps its dedupe/rate-limit state at module scope, so a fresh
// module instance per test (vi.resetModules) is the only way to test the
// circuit breaker and dedupe window in isolation from each other.
async function freshReporter() {
    vi.resetModules();
    return import('./errorReporter');
}

const fakeUser = { id: 'user-1', email: 'a@b.com' };

describe('reportClientError', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getSessionMock.mockResolvedValue({ data: { session: { user: fakeUser } } });
        insertMock.mockResolvedValue({});
    });

    it('does nothing when there is no message', async () => {
        const { reportClientError } = await freshReporter();
        await reportClientError({});
        expect(insertMock).not.toHaveBeenCalled();
    });

    it('does nothing when there is no active session (anonymous/pre-login error)', async () => {
        getSessionMock.mockResolvedValue({ data: { session: null } });
        const { reportClientError } = await freshReporter();
        await reportClientError({ message: 'boom' });
        expect(insertMock).not.toHaveBeenCalled();
    });

    it('inserts a row attributed to the current session user', async () => {
        const { reportClientError } = await freshReporter();
        await reportClientError({ message: 'boom', stack: 'at foo()', context: { source: 'test' } });
        expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
            user_id: 'user-1',
            user_email: 'a@b.com',
            message: 'boom',
            stack: 'at foo()',
            context: { source: 'test' },
        }));
    });

    it('does not report the exact same message+stack twice within the dedupe window', async () => {
        const { reportClientError } = await freshReporter();
        await reportClientError({ message: 'boom', stack: 'x' });
        await reportClientError({ message: 'boom', stack: 'x' });
        expect(insertMock).toHaveBeenCalledTimes(1);
    });

    it('does report two genuinely different errors', async () => {
        const { reportClientError } = await freshReporter();
        await reportClientError({ message: 'boom-a' });
        await reportClientError({ message: 'boom-b' });
        expect(insertMock).toHaveBeenCalledTimes(2);
    });

    it('stops reporting once the per-session cap is hit (runaway-error circuit breaker)', async () => {
        const { reportClientError } = await freshReporter();
        for (let i = 0; i < 25; i++) {
            await reportClientError({ message: `boom-${i}` }); // each one is a distinct signature, so dedupe never kicks in
        }
        expect(insertMock).toHaveBeenCalledTimes(20);
    });

    it('swallows a failure from the insert itself rather than throwing', async () => {
        insertMock.mockRejectedValue(new Error('network down'));
        const { reportClientError } = await freshReporter();
        await expect(reportClientError({ message: 'boom' })).resolves.toBeUndefined();
    });
});
