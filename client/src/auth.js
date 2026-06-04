import { apiUrl } from './config'

const TOKEN_KEY = 'cm_device_token';
const DEVICE_ID_KEY = 'cm_device_id';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export function getDeviceId() {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

// Decode the embedded device token from the gateway JWT (without verifying signature).
// Falls back to the raw token for backward compat with direct connections.
export function getDeviceToken() {
  const token = getToken();
  if (!token) return null;
  if (!token.includes('.')) return token; // plain hex token (direct connection)
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.deviceToken || token;
  } catch { return token; }
}

// Returns true if the stored token is a valid gateway JWT with required fields.
// Call on app startup — clears and returns false if the token is stale/old-format.
export function validateToken() {
  const token = getToken();
  if (!token) return false;
  // Old format: plain hex/alphanumeric (no dots) — not a gateway JWT
  if (!token.includes('.')) { clearToken(); return false; }
  try {
    const parts = token.split('.');
    if (parts.length !== 3) { clearToken(); return false; }
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    // Must have tunnelPort and deviceToken
    if (!payload.tunnelPort || !payload.deviceToken) { clearToken(); return false; }
    // Must not be expired
    if (payload.exp && payload.exp * 1000 < Date.now()) { clearToken(); return false; }
    return true;
  } catch { clearToken(); return false; }
}

export function authHeaders() {
  return { 'Authorization': `Bearer ${getToken()}` };
}

// Fetch that applies auth headers automatically.
// On 401 with expired:true the token is cleared so the app shows the login screen.
export async function fetchWithAuth(url, options = {}) {
  const res = await fetch(apiUrl(url), {
    ...options,
    headers: { ...options.headers, ...authHeaders() }
  });
  if (res.status === 401) {
    clearToken()
  }
  return res;
}
