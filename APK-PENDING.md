# APK pendiente — mejoras de resiliencia del cliente

Dos mejoras de resiliencia de conexión **viven en el cliente** y no se pudieron
desplegar con el server (1.8.0) porque requieren recompilar el APK. Se dejan
documentadas para resolver cuando se pueda reconstruir el APK de forma segura.

Contexto: el resto del paquete de resiliencia (heartbeat tolerante,
`maxHttpBufferSize`, `connectionStateRecovery`) ya está en el server 1.8.0.
Ver `ARCHITECTURE.md` y los memos del proyecto.

---

## ⚠️ Bloqueos a resolver ANTES de recompilar

Recompilar mal deja un APK **que no se puede instalar** sobre la app actual.
Dos requisitos:

1. **`google-services.json` (FCM).**
   - Ubicación: `client/android/app/google-services.json` (gitignored).
   - Si falta, el build **igual compila** pero **sin push** (ver
     `client/android/app/build.gradle:48-53`, que solo aplica el plugin si el
     archivo existe). Las notificaciones dejarían de llegar.
   - Se baja del Firebase Console del proyecto. Ver `FIREBASE_SETUP.md`. El
     gateway también expone `/firebase-config` (admin del lado server).

2. **Keystore de firma — DEBE ser la misma que firmó el APK instalado.**
   - `build-android.sh` hace `assembleDebug` → firma con la **debug keystore**
     `~/.android/debug.keystore` de la máquina que compila.
   - Si esa keystore se perdió/regeneró (o se compila en otra máquina), la
     firma cambia → Android rechaza instalar sobre la app existente
     (*"App not installed"*) y habría que **desinstalar primero**, perdiendo
     el token de login y el registro de push guardados.
   - **Acción recomendada:** preservar `~/.android/debug.keystore`, o migrar a
     una **release keystore estable** (hay un bloque `signingConfigs.release`
     en `client/android/app/build.gradle:20`) y guardarla fuera del repo, para
     que futuros builds sean instalables sobre los anteriores.

---

## Cambios de código a aplicar

### #2 — Fallback de transporte (redes que rompen el upgrade WebSocket)

`client/src/components/ChatView.jsx` (~línea 93), en la config de `io(...)`:

```diff
- transports: ['websocket'],
+ transports: ['websocket', 'polling'],
```

El server ya acepta `polling` (no restringe `transports`), así que es solo
cambio de cliente. Permite conectar tras portales cautivos / proxies que
bloquean el upgrade a WS.

### #5 — Timeout + 1 reintento en las llamadas REST

`client/src/auth.js` — `fetchWithAuth` hoy es un `fetch` pelado sin timeout, así
que en una conexión estancada se cuelga hasta el timeout del SO sin reintentar.
Sugerido:

```js
export async function fetchWithAuth(url, options = {}, { timeoutMs = 15000, retries = 1 } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(apiUrl(url), {
        ...options,
        headers: { ...options.headers, ...authHeaders() },
        signal: options.signal || ctrl.signal,
      })
      clearTimeout(t)
      if (res.status === 401) clearToken()
      return res
    } catch (err) {
      clearTimeout(t)
      lastErr = err   // abort/red: reintenta; respuesta real ya retornó arriba
    }
  }
  throw lastErr
}
```

---

## Build + publicación (cuando los bloqueos estén resueltos)

```bash
# 1. Compilar (Linux; ver build-android.sh para deps: JDK 21, Android SDK 34)
./build-android.sh
#    -> client/android/app/build/outputs/apk/debug/app-debug.apk

# 2. Subir al VPS como el APK servido
scp client/android/app/build/outputs/apk/debug/app-debug.apk \
    root@claude.polymitia.tech:/var/www/claude-mobile/app.apk

# 3. Bumpear el campo "latest" de version.json (el banner de APK usa "latest",
#    no "server"). p.ej. latest: "1.9.0". serverUrl/server quedan igual.
```

El banner de actualización de APK en la app compara `latest` contra
`__APP_VERSION__` y ofrece el link a `apkUrl` (`client/src/UpdateModal.jsx`).
La instalación es manual (Android no permite auto-instalar).

## Verificación

```bash
curl -sI https://claude.polymitia.tech/app.apk | grep -i content-length
curl -s  https://claude.polymitia.tech/version.json
```
