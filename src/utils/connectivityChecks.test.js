import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../supabaseClient', () => ({
    supabaseUrl: 'https://test-project.supabase.co',
    supabaseAnonKey: 'test-anon-key',
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

    it('reports a specific "timeout" reason when the request hangs forever', async () => {
        fetchMock.mockReturnValue(new Promise(() => {})); // never resolves
        const resultPromise = checkSupabaseReachable();
        await vi.advanceTimersByTimeAsync(7000); // past the 6000ms probe timeout
        const result = await resultPromise;
        expect(result.ok).toBe(false);
        expect(result.error).toBe('timeout');
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
    it('checkHuggingFaceCdnReachable probes the YOLO model host', async () => {
        fetchMock.mockResolvedValue({ type: 'opaque' });
        const resultPromise = checkHuggingFaceCdnReachable();
        await vi.runAllTimersAsync();
        const result = await resultPromise;
        expect(result.ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringContaining('huggingface.co'),
            expect.objectContaining({ mode: 'no-cors' })
        );
    });

    it('checkSupabaseRealtimeReachable probes the realtime endpoint', async () => {
        fetchMock.mockResolvedValue({ ok: true });
        const resultPromise = checkSupabaseRealtimeReachable();
        await vi.runAllTimersAsync();
        const result = await resultPromise;
        expect(result.ok).toBe(true);
        expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/realtime/v1/'), expect.any(Object));
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
