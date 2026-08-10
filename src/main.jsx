import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n.js'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { webVitalsBatcher } from './telemetry/webVitalsBatcher.js'
import { reportClientError } from './monitoring/errorReporter.js'
import { registerSW } from 'virtual:pwa-register'

webVitalsBatcher.start()

// 🟩 STALE-CHUNK RECOVERY: every deploy renames the built JS chunks
// (content-hashed filenames). A tab left open across a deploy still holds
// the OLD index.html's chunk map in memory, so a later React.lazy()/dynamic
// import 404s against the new deployment -- this is unrecoverable without a
// reload since the old chunk simply no longer exists on the server. Force a
// single automatic reload the first time this happens per session instead
// of leaving the user stuck on a silently broken page.
const RELOAD_GUARD_KEY = 'chunk-reload-guard';
function recoverFromStaleChunk(message) {
  if (!/dynamically imported module|Loading chunk|Importing a module script failed/i.test(message || '')) return false;
  if (sessionStorage.getItem(RELOAD_GUARD_KEY)) return false;
  sessionStorage.setItem(RELOAD_GUARD_KEY, '1');
  window.location.reload();
  return true;
}

// 🟩 ERROR MONITOR COVERAGE: ErrorBoundary only catches errors thrown
// during React's render -- an exception in an event handler, a timer
// callback, or an unhandled promise rejection anywhere in the app would
// otherwise never reach it (or this app's error-reporting pipeline at
// all). These two listeners are the catch-all for everything else.
window.addEventListener('error', (event) => {
  const message = event.error?.message || event.message;
  if (recoverFromStaleChunk(message)) return;
  reportClientError({
    message,
    stack: event.error?.stack,
    context: { source: 'window.onerror' },
  });
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const message = reason?.message || String(reason);
  if (recoverFromStaleChunk(message)) return;
  reportClientError({
    message,
    stack: reason?.stack,
    context: { source: 'unhandledrejection' },
  });
});

// 🟩 SW UPDATE ENFORCEMENT: registerType: 'autoUpdate' only makes the
// *service worker* activate the new precache in the background -- it does
// NOT reload tabs that are already open, so a long-lived session keeps
// running old in-memory JS against a cache that's moved on. Poll for
// updates periodically and reload once a new SW has taken control, so
// "nothing changed after deploy" stops being possible for anyone who
// leaves the tab open.
if ('serviceWorker' in navigator) {
  const updateSW = registerSW({
    immediate: true,
    onRegisteredSW(_url, registration) {
      if (!registration) return;
      setInterval(() => registration.update().catch(() => {}), 30 * 60 * 1000);
    },
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    updateSW(true).catch(() => window.location.reload());
  });
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
