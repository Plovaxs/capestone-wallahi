import { supabase } from '../supabaseClient';
import { clientErrorLogsRepository } from '../data/repositories/clientErrorLogsRepository';

/**
 * Self-hosted, Sentry-style client error capture -- no third-party account
 * needed. Feeds the supervisor-only "Error Monitor" view (see
 * views/ErrorMonitorView.jsx). Previously a client-side crash or a failed
 * API call was only ever visible in that one user's own browser console;
 * nobody on the team would ever know it happened unless the user reported
 * it themselves.
 *
 * Wired into three places, covering the realistic surface of "things that
 * go wrong" in this app:
 * - components/ErrorBoundary.jsx (componentDidCatch) -- uncaught render errors
 * - utils/errorHandling.js (showUserError) -- every handled API/mutation
 *   failure already flowing through the app's one error-toast choke point
 * - main.jsx (window 'error' / 'unhandledrejection') -- everything else
 *   (event handlers, async code outside React's render cycle)
 */

// 🟩 CIRCUIT BREAKER: a broken render loop or a repeatedly-failing request
// could otherwise report hundreds of times a second -- a hard per-session
// cap means a runaway error can never turn into a self-inflicted DB/network
// flood on top of whatever's already gone wrong.
const MAX_REPORTS_PER_SESSION = 20;
// 🟩 DEDUPE: the same error often fires many times in a row (a re-render
// loop, a retried request) -- only the first occurrence within this window
// is worth a fresh row; the rest are the same signal repeated.
const DEDUPE_WINDOW_MS = 10000;

let reportCount = 0;
const recentSignatures = new Map();

function getSignature(message, stack) {
    return `${message}::${(stack || '').slice(0, 200)}`;
}

/**
 * @param {object} params
 * @param {string} params.message
 * @param {string} [params.stack]
 * @param {object} [params.context] - small, JSON-serializable extra info (e.g. { source: 'ErrorBoundary' } or an errorHandling.js contextKey)
 */
export async function reportClientError({ message, stack, context } = {}) {
    try {
        if (!message) return;
        if (reportCount >= MAX_REPORTS_PER_SESSION) return;

        const signature = getSignature(message, stack);
        const now = Date.now();
        const lastReported = recentSignatures.get(signature);
        if (lastReported && now - lastReported < DEDUPE_WINDOW_MS) return;
        recentSignatures.set(signature, now);

        // getSession() reads the cached session (no network round trip) --
        // cheap enough to call on every report, unlike getUser() which
        // revalidates against the server every time.
        const { data: { session } } = await supabase.auth.getSession();
        const user = session?.user;
        // The insert RLS policy requires auth.uid() = user_id -- an
        // anonymous/pre-login error (e.g. on the Login page itself) has no
        // session to attribute it to, so there's nowhere safe to log it.
        if (!user) return;

        reportCount += 1;
        await clientErrorLogsRepository.insert({
            user_id: user.id,
            user_email: user.email || null,
            message: String(message).slice(0, 2000),
            stack: stack ? String(stack).slice(0, 8000) : null,
            url: typeof window !== 'undefined' ? window.location.href : null,
            user_agent: typeof navigator !== 'undefined' ? navigator.userAgent : null,
            context: context || null,
        });
    } catch (_err) {
        // Reporting a crash must never itself throw or add a second failure
        // on top of the first -- if this fails for any reason (offline, RLS
        // denies it, table doesn't exist yet), just give up silently.
    }
}
