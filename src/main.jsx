import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n.js'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { webVitalsBatcher } from './telemetry/webVitalsBatcher.js'
import { reportClientError } from './monitoring/errorReporter.js'

webVitalsBatcher.start()

// 🟩 ERROR MONITOR COVERAGE: ErrorBoundary only catches errors thrown
// during React's render -- an exception in an event handler, a timer
// callback, or an unhandled promise rejection anywhere in the app would
// otherwise never reach it (or this app's error-reporting pipeline at
// all). These two listeners are the catch-all for everything else.
window.addEventListener('error', (event) => {
  reportClientError({
    message: event.error?.message || event.message,
    stack: event.error?.stack,
    context: { source: 'window.onerror' },
  });
});
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  reportClientError({
    message: reason?.message || String(reason),
    stack: reason?.stack,
    context: { source: 'unhandledrejection' },
  });
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
