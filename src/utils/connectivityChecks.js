import { withTimeout } from '../data/pipeline/withTimeout';
import { supabaseUrl, supabaseAnonKey } from '../supabaseClient';

const DEFAULT_TIMEOUT_MS = 6000;

/**
 * One reachability probe: times a fetch, classifies the result as
 * ok/timeout/error, and never throws -- every check in this file is meant
 * to be run from a UI that shows the result, not a try/catch. This is
 * exactly the class of check that would have caught the "attendance face
 * recognition doesn't work but login does" bug in one click instead of a
 * full code-reading session: that bug was specifically the YOLO model
 * fetch (checkHuggingFaceCdnReachable below) hanging forever on a network
 * that couldn't reach Hugging Face's CDN, with no timeout anywhere to
 * surface it.
 */
async function probe(label, fetchFn, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const startedAt = performance.now();
    try {
        await withTimeout(fetchFn(), timeoutMs, label);
        return { label, ok: true, latencyMs: Math.round(performance.now() - startedAt), error: null };
    } catch (error) {
        const isTimeout = /timed out/i.test(error?.message || '');
        return {
            label,
            ok: false,
            latencyMs: Math.round(performance.now() - startedAt),
            error: isTimeout ? 'timeout' : (error?.message || 'unknown error'),
        };
    }
}

/** Supabase's own REST endpoint -- same lightweight HEAD request utils/serverTime.js already uses for clock sync, so this doesn't add a new backend dependency. */
export const checkSupabaseReachable = () => probe('supabase', () =>
    fetch(`${supabaseUrl}/rest/v1/`, { method: 'HEAD', headers: { apikey: supabaseAnonKey } })
);

/** Supabase's Realtime websocket endpoint, over plain HTTP (just confirms the host/port answers -- doesn't open a full websocket, which needs an active client context this util doesn't have). */
export const checkSupabaseRealtimeReachable = () => probe('supabase-realtime', () =>
    fetch(`${supabaseUrl.replace(/^http/, 'http')}/realtime/v1/`, { method: 'HEAD', headers: { apikey: supabaseAnonKey } })
);

/** The exact host AttendanceView's YOLO face detector fetches its model from -- see vision/faceDiagnostics.js and the YOLO timeout fix in AttendanceView.jsx. */
export const checkHuggingFaceCdnReachable = () => probe('huggingface-cdn', () =>
    fetch('https://huggingface.co/api/models/Xenova/yolov8n-face', { method: 'HEAD', mode: 'no-cors' })
);

/** The local face-api.js model weights every face-scan page (Login, Attendance) depends on -- confirms they're actually being served, not a 404 from a broken deploy/CDN path. */
export const checkFaceApiModelsReachable = () => probe('face-api-models', () =>
    fetch(`${import.meta.env.VITE_FACE_MODEL_URL || '/models'}/tiny_face_detector_model-weights_manifest.json`, { method: 'GET' })
);

/** Runs every check in parallel -- independent probes, no reason to serialize them. */
export async function runAllConnectivityChecks() {
    const [supabase, supabaseRealtime, huggingFace, faceApiModels] = await Promise.all([
        checkSupabaseReachable(),
        checkSupabaseRealtimeReachable(),
        checkHuggingFaceCdnReachable(),
        checkFaceApiModelsReachable(),
    ]);
    return [supabase, supabaseRealtime, huggingFace, faceApiModels];
}
