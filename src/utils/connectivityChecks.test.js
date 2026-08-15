import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 🟩 vi.hoisted -- see the identical pattern/rationale in
// DebugCenterView.test.jsx: these mock fns are configured inside the
// hoisted vi.mock factory below AND asserted-on/reconfigured in the test
// bodies further down, which needs them declared before the factory runs.
const { channelSubscribeMock, removeChannelMock } = vi.hoisted(() => ({
    // Default: immediately reports SUBSCRIBED, same as a healthy realtime
    // connection -- individual tests override this via mockImplementation
    // to simulate a failure/hang.
    channelSubscribeMock: vi.fn((cb) => { cb('SUBSCRIBED'); return { subscribe: channelSubscribeMock }; }),
    removeChannelMock: vi.fn(() => Promise.resolve()),
}));

vi.mock('../supabaseClient', () => ({
    supabaseUrl: 'https://test-project.supabase.co',
    supabaseAnonKey: 'test-anon-key',
    supabase: {
        channel: vi.fn(() => ({ subscribe: channelSubscribeMock })),
        removeChannel: removeChannelMock,
    },
}));

import {
    checkSupabaseReachable,
    checkSupabaseRealtimeReachable,
    checkHuggingFaceCdnReachable,
    checkFaceApiModelsReachable,
    runAllConnectivityChecks,
} from './connectivityChecks';

describe('connectivityChecks', () => {
    let fetchMock;

    beforeEach(() => {
        vi.useFakeTimers();
        fetchMock = vi.fn();
        globalThis.fetch = fetchMock;
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('reports ok:true with a latency reading when the request succeeds', async () => {
        fetchMock.mockResolvedValue({ ok: true });
        const resultPromise = checkSupabaseReachable();
        await vi.runAllTimersAsync();
        const result = await resultPromise;
        expect(result.ok).toBe(true);
        expect(result.error).toBeNull();
        expect(typeof result.latencyMs).toBe('number');
    });

    // 🟩 REGRESSION TEST: verified live on a real deployment -- sending only
    // `apikey` (no `Authorization`) got a real 401 from Supabase's gateway
    // even though the same key worked fine for every supabase-js call on
    // that same page (which always sends both headers).
    it('checkSupabaseReachable sends both apikey and Authorization headers, matching what supabase-js itself sends', async () => {
        fetchMock.mockResolvedValue({ ok: true });
        const resultPromise = checkSupabaseReachable();
        await vi.runAllTimersAsync();
        await resultPromise;
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/rest/v1/'), {
            method: 'HEAD',
            headers: { apikey: 'test-anon-key', Authorization: 'Bearer test-anon-key' },
        });
    });

    it('reports a specific "timeout" reason when the request hangs forever', async () => {
        fetchMock.mockReturnValue(new Promise(() => {})); // never resolves
        const resultPromise = checkSupabaseReachable();
        await vi.advanceTimersByTimeAsync(7000); // past the 6000ms probe timeout
        const result = await resultPromise;
        expect(result.ok).toBe(false);
        expect(result.error).toBe('timeout');
    });

    it('reports unreachable when the request resolves but with a non-ok HTTP status', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 500 });
        const resultPromise = checkSupabaseReachable();
        await vi.runAllTimersAsync();
        const result = await resultPromise;
        expect(result.ok).toBe(false);
        expect(result.error).toBe('HTTP 500');
    });

    it('reports the underlying error message when the request rejects outright (not a timeout)', async () => {
        fetchMock.mockRejectedValue(new Error('Failed to fetch'));
        const resultPromise = checkSupabaseReachable();
        await vi.runAllTimersAsync();
        const result = await resultPromise;
        expect(result.ok).toBe(false);
        expect(result.error).toBe('Failed to fetch');
    });

    // 🟩 This is the exact check that would have caught the reported
    // "attendance face recognition doesn't work but login does" bug --
    // AttendanceView's YOLO detector fetches its model from this same host.
    it('checkHuggingFaceCdnReachable probes the YOLO model host and reports success on a 2xx', async () => {
        fetchMock.mockResolvedValue({ ok: true, status: 200 });
        const resultPromise = checkHuggingFaceCdnReachable();
        await vi.runAllTimersAsync();
        const result = await resultPromise;
        expect(result.ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('huggingface.co'), expect.any(Object));
        // Not mode:'no-cors' -- verified live that Hugging Face's model API
        // sends normal CORS headers, and no-cors would make `res.ok` always
        // false (an opaque response, by spec) even on genuine success,
        // which would make the check below (a real 401) indistinguishable
        // from a real success.
        expect(fetchMock).toHaveBeenCalledWith(expect.any(String), expect.not.objectContaining({ mode: 'no-cors' }));
    });

    // 🟩 REGRESSION TEST: verified live against the real Hugging Face API --
    // Xenova/yolov8n-face (the exact model AttendanceView's YOLO detector
    // depends on) currently returns 401 "Invalid username or password" for
    // every request, unconditionally -- not a network/timeout issue at
    // all. A resolved-but-non-ok fetch() promise previously made this
    // check report "reachable" regardless of the actual HTTP status.
    it('checkHuggingFaceCdnReachable reports unreachable on a real HTTP error status (e.g. 401), not just network failures', async () => {
        fetchMock.mockResolvedValue({ ok: false, status: 401 });
        const resultPromise = checkHuggingFaceCdnReachable();
        await vi.runAllTimersAsync();
        const result = await resultPromise;
        expect(result.ok).toBe(false);
        expect(result.error).toBe('HTTP 401');
    });

    // 🟩 REGRESSION TEST: verified live on a real deployment -- the old
    // implementation did a plain `fetch()` HEAD against /realtime/v1/,
    // which failed with a browser CORS error (blocked before the response
    // status was even readable) despite the realtime connection itself
    // being perfectly healthy. Now goes through supabase-js's own
    // websocket channel subscribe, which doesn't hit fetch's CORS
    // machinery at all.
    it('checkSupabaseRealtimeReachable opens a realtime channel and reports success once SUBSCRIBED', async () => {
        const result = await checkSupabaseRealtimeReachable();
        expect(result.ok).toBe(true);
        expect(result.error).toBeNull();
        expect(removeChannelMock).toHaveBeenCalled();
    });

    it('checkSupabaseRealtimeReachable reports unreachable when the channel reports CHANNEL_ERROR', async () => {
        channelSubscribeMock.mockImplementationOnce((cb) => { cb('CHANNEL_ERROR'); return { subscribe: channelSubscribeMock }; });
        const result = await checkSupabaseRealtimeReachable();
        expect(result.ok).toBe(false);
        expect(result.error).toBe('CHANNEL_ERROR');
    });

    it('checkFaceApiModelsReachable probes the local model manifest', async () => {
        fetchMock.mockResolvedValue({ ok: true });
        const resultPromise = checkFaceApiModelsReachable();
        await vi.runAllTimersAsync();
        await resultPromise;
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('tiny_face_detector_model-weights_manifest.json'),
            expect.any(Object)
        );
    });

    it('runAllConnectivityChecks runs all four probes and returns one result per probe', async () => {
        fetchMock.mockResolvedValue({ ok: true });
        const resultsPromise = runAllConnectivityChecks();
        await vi.runAllTimersAsync();
        const results = await resultsPromise;
        expect(results).toHaveLength(4);
        expect(results.map((r) => r.label)).toEqual([
            'supabase', 'supabase-realtime', 'huggingface-cdn', 'face-api-models',
        ]);
        expect(results.every((r) => r.ok)).toBe(true);
    });

    it('a hanging probe does not block the others in runAllConnectivityChecks', async () => {
        fetchMock.mockImplementation((url) => (
            String(url).includes('huggingface.co') ? new Promise(() => {}) : Promise.resolve({ ok: true })
        ));
        const resultsPromise = runAllConnectivityChecks();
        await vi.advanceTimersByTimeAsync(7000);
        const results = await resultsPromise;
        const huggingFaceResult = results.find((r) => r.label === 'huggingface-cdn');
        const supabaseResult = results.find((r) => r.label === 'supabase');
        expect(huggingFaceResult.ok).toBe(false);
        expect(huggingFaceResult.error).toBe('timeout');
        expect(supabaseResult.ok).toBe(true);
    });
});
