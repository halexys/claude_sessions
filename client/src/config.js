// Base URL of the gateway. When the UI is bundled inside the APK the
// document origin is `capacitor://localhost`, so relative paths like
// "/api/..." would target the WebView itself. In dev (vite) the origin is
// the dev server and the proxy handles routing, so we leave the base empty.
// Override at build time with VITE_API_BASE for your own deployment.
// e.g. VITE_API_BASE=https://claude.you.tech npm run build
export const API_BASE = import.meta.env.PROD
  ? (import.meta.env.VITE_API_BASE || 'https://claude.example.com')
  : ''

export function apiUrl(path) {
  if (/^https?:\/\//i.test(path)) return path
  return API_BASE + (path.startsWith('/') ? path : '/' + path)
}
