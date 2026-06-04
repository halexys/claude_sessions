#!/bin/bash
set -e

ANDROID_HOME="$HOME/Android/Sdk"
CMDLINE_TOOLS_URL="https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"

echo "=== Claude Mobile — Android APK build ==="

# ── 0. Java 17 (Gradle no soporta Java 26) ────────────────────────────────────
if [ ! -d "/usr/lib/jvm/java-21-openjdk" ]; then
  echo "[0/4] Instalando JDK 21..."
  sudo pacman -S --noconfirm jdk21-openjdk
fi
export JAVA_HOME=/usr/lib/jvm/java-21-openjdk
export PATH="$JAVA_HOME/bin:$PATH"
echo "    Java: $(java -version 2>&1 | head -1)"

# ── 1. Android SDK command line tools ──────────────────────────────────────────
if [ ! -f "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
  echo "[1/4] Descargando Android SDK command line tools (~150MB)..."
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  cd /tmp
  curl -L -o cmdline-tools.zip "$CMDLINE_TOOLS_URL"
  unzip -q cmdline-tools.zip -d "$ANDROID_HOME/cmdline-tools/"
  mv "$ANDROID_HOME/cmdline-tools/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm cmdline-tools.zip
  echo "    SDK tools instalados."
else
  echo "[1/4] SDK tools ya presentes, omitiendo descarga."
fi

export ANDROID_HOME
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$PATH"

# ── 2. SDK packages ────────────────────────────────────────────────────────────
echo "[2/4] Instalando SDK packages (puede tardar ~5 min la primera vez)..."
yes | sdkmanager --licenses > /dev/null 2>&1 || true
sdkmanager --install \
  "platform-tools" \
  "platforms;android-34" \
  "build-tools;34.0.0" 2>&1 | grep -E "^(Downloading|Installing|done)" || true
echo "    Packages instalados."

# ── 3. Sync Capacitor & build frontend ────────────────────────────────────────
echo "[3/4] Sincronizando Capacitor..."
cd "$(dirname "$0")/client"
npm run build 2>&1 | tail -2
npx cap sync android 2>&1 | tail -3

# local.properties
echo "sdk.dir=$ANDROID_HOME" > android/local.properties

# ── 4. Build APK ───────────────────────────────────────────────────────────────
echo "[4/4] Compilando APK debug..."
cd android
chmod +x gradlew
./gradlew assembleDebug --no-daemon 2>&1 | grep -E "^(BUILD|Task|>|\s*>)" | tail -20

APK_PATH="app/build/outputs/apk/debug/app-debug.apk"
if [ -f "$APK_PATH" ]; then
  SIZE=$(du -h "$APK_PATH" | cut -f1)
  echo ""
  echo "======================================"
  echo " APK listo: $SIZE"
  echo " $(pwd)/$APK_PATH"
  echo "======================================"
  echo ""
  echo "Instalar en Android por USB:"
  echo "  adb install $APK_PATH"
  echo ""
  echo "O transferir el APK al móvil y abrir con el gestor de archivos."
else
  echo "ERROR: no se encontró el APK. Revisa los logs arriba."
  exit 1
fi
