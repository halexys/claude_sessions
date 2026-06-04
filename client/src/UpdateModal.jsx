import { useEffect, useState } from 'react'
import { API_BASE } from './config'
import Icon from './components/Icon.jsx'

// Reads /version.json on app startup. Shows a non-dismissable banner when
// the bundled APK is older than the latest available.
export default function UpdateChecker() {
  const [update, setUpdate] = useState(null) // { latest, apkUrl, releaseNotes? }
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const url = (API_BASE || '') + '/version.json?ts=' + Date.now()
    fetch(url, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        if (!d || !d.latest) return
        if (isNewer(d.latest, __APP_VERSION__)) {
          setUpdate(d)
          setOpen(true)
        }
      })
      .catch(() => {})
  }, [])

  if (!update || !open) return null

  return (
    <div className="fixed inset-x-0 top-0 z-[60] flex justify-center pointer-events-none">
      <div className="m-3 max-w-md w-full bg-amber-600 text-white rounded-xl shadow-2xl pointer-events-auto">
        <div className="px-4 py-3 flex items-center gap-3">
          <Icon name="arrow-up" className="w-5 h-5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">Nueva versión disponible</p>
            <p className="text-xs text-amber-100">
              {__APP_VERSION__} → {update.latest}
              {update.releaseNotes ? ` · ${update.releaseNotes}` : ''}
            </p>
          </div>
          <a
            href={update.apkUrl}
            target="_blank"
            rel="noreferrer"
            className="px-3 py-1.5 rounded-lg bg-white text-amber-700 text-xs font-semibold active:bg-amber-50"
          >
            Actualizar
          </a>
          <button
            onClick={() => setOpen(false)}
            aria-label="Cerrar"
            className="w-7 h-7 flex items-center justify-center rounded-lg text-amber-100 active:bg-amber-700"
          ><Icon name="x" className="w-4 h-4" /></button>
        </div>
      </div>
    </div>
  )
}

function isNewer(remote, local) {
  const a = String(remote).split('.').map(n => parseInt(n, 10) || 0)
  const b = String(local).split('.').map(n => parseInt(n, 10) || 0)
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i] || 0, y = b[i] || 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}
