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
        const res = await withTimeout(fetchFn(), timeoutMs, label);
        // 🟩 BUG FIX: a resolved fetch() promise only means the request
        // reached a server and got SOME response back -- it says nothing
        // about whether that response was actually a success. Verified
        // live: Xenova/yolov8n-face (the YOLO model AttendanceView depends
        // on) now returns 401 "Invalid username or password" -- the org's
        // models require auth on Hugging Face's side, unrelated to network
        // reachability at all. `res.ok` (false for any 4xx/5xx) is checked
        // explicitly now instead of treating "the promise didn't reject" as
        // success, so a hard-rejected/gated/moved resource is correctly
        // reported as unreachable instead of a false "reachable".
        if (res && typeof res.ok === 'boolean' && !res.ok) {
            throw new Error(`HTTP ${res.status}`);
        }
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

/** Supabase's Realtime websocket endpoint, over plain HTTP (just confirms the host/port answers -- doesn't open a full websocket, which needs an active client context this util doesn't have; DebugCenterView's Realtime tab does that deeper check separately). */
export const checkSupabaseRealtimeReachable = () => probe('supabase-realtime', () =>
    fetch(`${supabaseUrl}/realtime/v1/`, { method: 'HEAD', headers: { apikey: supabaseAnonKey } })
);

/**
 * General Hugging Face API reachability -- deliberately NOT
 * Xenova/yolov8n-face (the model AttendanceView's YOLO path used to try).
 * Verified live that every Xenova-org model now returns 401 "Invalid
 * username or password" unconditionally -- a permanent access
 * restriction on Hugging Face's side, not a per-user network condition,
 * so probing it here would report "unreachable" forever regardless of
 * this browser's actual connectivity (useless signal), AND would
 * guarantee the same un-suppressible "Failed to load resource: 401"
 * browser console line every time a supervisor runs this check.
 * AttendanceView.jsx no longer attempts that model at all (see
 * YOLO_KNOWN_BROKEN there) -- this checks a stable, canonical public
 * model instead, purely as a general "can this browser reach Hugging
 * Face's infrastructure at all" signal, useful if YOLO acceleration is
 * ever re-enabled against a working model id. Deliberately NOT
 * `mode: 'no-cors'` -- verified live that Hugging Face's model API sends
 * normal CORS headers, and no-cors would make `res.ok` always false (an
 * opaque response, by spec) even on genuine success.
 */
export const checkHuggingFaceCdnReachable = () => probe('huggingface-cdn', () =>
    fetch('https://huggingface.co/api/models/bert-base-uncased', { method: 'HEAD' })
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
