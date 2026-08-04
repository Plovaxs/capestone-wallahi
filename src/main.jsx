import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n.js'
import App from './App.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'
import { webVitalsBatcher } from './telemetry/webVitalsBatcher.js'

webVitalsBatcher.start()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
