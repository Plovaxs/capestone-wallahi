import { withTimeout } from '../data/pipeline/withTimeout';
import { supabase, supabaseUrl, supabaseAnonKey } from '../supabaseClient';

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

/**
 * Supabase's own REST endpoint -- same lightweight HEAD request
 * utils/serverTime.js already uses for clock sync, so this doesn't add a
 * new backend dependency.
 * 🟩 BUG FIX: sent only the `apikey` header -- reported live as a 401 on
 * a real deployment even though the same anon key worked for every other
 * Supabase call on that page (which all go through supabase-js, which
 * always sends BOTH `apikey` and `Authorization: Bearer <anon key>`).
 * Supabase's gateway can reject a request missing `Authorization`
 * depending on project config, so a plain HEAD sending only `apikey` was
 * a strictly weaker request than what the rest of the app actually relies
 * on -- this probe could report "unreachable" on a deployment that was
 * working completely fine otherwise. Sending both matches what
 * supabase-js itself sends.
 */
export const checkSupabaseReachable = () => probe('supabase', () =>
    fetch(`${supabaseUrl}/rest/v1/`, {
        method: 'HEAD',
        headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${supabaseAnonKey}` },
    })
);

/**
 * Supabase Realtime reachability, checked the same way DebugCenterView's
 * dedicated Realtime tab already does: actually opening a short-lived
 * websocket channel via supabase-js and waiting for SUBSCRIBED, not a
 * plain `fetch()` HEAD against the /realtime/v1/ HTTP path.
 * 🟩 BUG FIX: the old HEAD-fetch approach was verified live to fail with
 * a browser CORS error on a real deployment -- Realtime's HTTP endpoint
 * exists to negotiate a websocket upgrade, and Supabase doesn't
 * necessarily serve CORS headers on it for a plain cross-origin HEAD
 * request. supabase-js's own websocket client sidesteps this entirely
 * (the browser's CORS preflight machinery only applies to `fetch`/XHR,
 * not the WebSocket handshake), so this is both more accurate (tests the
 * actual protocol the app depends on) and doesn't throw an
 * un-suppressible "blocked by CORS policy" console line for a routine
 * diagnostic check.
 */
export const checkSupabaseRealtimeReachable = () => probe('supabase-realtime', async () => {
    const channel = supabase.channel(`connectivity-probe-${Date.now()}`);
    try {
        const failureStatus = await new Promise((resolve) => {
            channel.subscribe((status) => {
                if (status === 'SUBSCRIBED') resolve(null);
                else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') resolve(status);
            });
        });
        if (failureStatus) throw new Error(failureStatus);
        return { ok: true };
    } finally {
        await supabase.removeChannel(channel);
    }
});

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
