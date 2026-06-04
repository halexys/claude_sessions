# Firebase setup (push notifications)

Optional but recommended — without Firebase the app still works, you just
don't get push notifications when Claude finishes a turn or asks for input.

## 1. Create the Firebase project

1. Go to https://console.firebase.google.com
2. **Add project** → name it whatever you want (e.g. `claude-mobile`) →
   skip Analytics → Create
3. In the project panel, enable **Cloud Messaging**

## 2. Register the Android app

1. In the project panel: **Add app** → **Android**
2. Use the package name from `client/capacitor.config.json` →
   `appId` field (default: `tech.polymitia.claude` — change this to your own
   reverse-domain identifier first if you're going to publish your own APK).
3. Download `google-services.json`
4. Place it at `client/android/app/google-services.json`

## 3. Service account for the server

1. Firebase Console → Project settings → **Service accounts**
2. **Generate new private key** → downloads a JSON
3. Upload this file to your VPS at
   `/var/www/claude-mobile/firebase-service-account.json`. The gateway's
   `/firebase-config` endpoint (gated by `X-Setup-Secret`) serves it to
   each PC installer.

If you skip step 3, push notifications are silently disabled — installer
prints `push notifications: skipped (no firebase config)`.

## 4. Rebuild the APK

```bash
cd client
npm run build
npx cap sync android
cd android && JAVA_HOME=/usr/lib/jvm/java-21-openjdk ./gradlew assembleDebug
```

The new APK is at `client/android/app/build/outputs/apk/debug/app-debug.apk`.
Upload to `/var/www/claude-mobile/app.apk` on your VPS.

## 5. Hooks on the user's PC (automated)

`install.sh` already drops the hooks for you (`~/.claude/hooks/push.sh`
plus entries in `~/.claude/settings.json` for `Notification` and `Stop`
events). The hooks POST to `localhost:3001/api/hook/<event>` with a
shared secret, and the server then sends FCM messages to every device
that registered its FCM token via `/api/push-token`.

## Changing the package name

If you fork this and publish your own APK, change `tech.polymitia.claude`
to your own reverse-domain identifier in:

- `client/capacitor.config.json` (`appId`)
- `client/android/app/build.gradle` (`namespace`, `applicationId`)
- `client/android/app/src/main/AndroidManifest.xml` (`package`)
- `client/android/app/src/main/java/.../MainActivity.java` (package
  declaration + directory path)
- `client/android/app/src/main/res/values/strings.xml`
  (`package_name`, `custom_url_scheme`)

Then re-register the new package name in Firebase and download a fresh
`google-services.json`.
