import React from 'react'
import ReactDOM from 'react-dom/client'

window.addEventListener('unhandledrejection', e => {
  console.error('[unhandled]', e.reason)
})
import App from './App.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
)
