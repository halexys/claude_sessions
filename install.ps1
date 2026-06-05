# Claude Mobile - Windows installer
# Usage: irm https://claude.polymitia.tech/install.ps1 | iex
# Or:    powershell -ExecutionPolicy Bypass -File install.ps1 <invite-code>
#
# Prerequisites: Node.js 18+, OpenSSH (built into Windows 10/11)

param([string]$Invite = "")

$GATEWAY   = "https://claude.polymitia.tech"
$INSTALL_DIR = Join-Path $env:USERPROFILE ".local\share\claude-mobile"
$SSH_KEY     = Join-Path $env:USERPROFILE ".ssh\claude_tunnel"
$HOOKS_DIR   = Join-Path $env:USERPROFILE ".claude\hooks"
$SETTINGS    = Join-Path $env:USERPROFILE ".claude\settings.json"

function Write-Green($msg) { Write-Host $msg -ForegroundColor Green }
function Write-Bold($msg)  { Write-Host $msg -ForegroundColor White }
function Write-Err($msg)   { Write-Host "Error: $msg" -ForegroundColor Red; exit 1 }

# ── Hooks-only mode ───────────────────────────────────────────────────────────
if ($Invite -eq "--hooks-only") {
    Write-Bold "Configurando hooks de notificaciones..."
    $envFile = Join-Path $INSTALL_DIR ".env"
    $setupSecret = ""
    if (Test-Path $envFile) {
        $setupSecret = (Get-Content $envFile | Where-Object { $_ -match "^SETUP_SECRET=" }) -replace "^SETUP_SECRET=", ""
    }
    if ($setupSecret) {
        $tmpTar = Join-Path $env:TEMP "claude-mobile-server.tar.gz"
        Invoke-WebRequest "$GATEWAY/server.tar.gz" -OutFile $tmpTar -UseBasicParsing
        tar -xzf $tmpTar -C $INSTALL_DIR --strip-components=1
        Remove-Item $tmpTar -Force
        Restart-ScheduledTask -TaskName "ClaudeMobile" -ErrorAction SilentlyContinue
        Start-Sleep 2
    }
    Install-Hooks
    Write-Green "Hooks configurados."
    exit 0
}

# ── Check prerequisites ───────────────────────────────────────────────────────
Write-Bold "Claude Mobile - Windows installer"
Write-Host ""
Write-Host "Verificando prerequisitos..."

$nodeVer = & node --version 2>$null
if (-not $?) { Write-Err "Node.js no encontrado. Instalalo en https://nodejs.org" }
$nodeMaj = [int]($nodeVer -replace "v(\d+)\..*", '$1')
if ($nodeMaj -lt 18) { Write-Err "Node.js 18+ requerido (encontrado $nodeVer)" }

$sshBin = (Get-Command ssh -ErrorAction SilentlyContinue)
if (-not $sshBin) { Write-Err "SSH no encontrado. Activa OpenSSH en Configuracion > Apps > Caracteristicas opcionales." }

if (-not $Invite) {
    Write-Err "Se requiere un codigo de invitacion.`n`n  Uso: powershell -File install.ps1 INVITE_CODE"
}

Write-Host "  node $nodeVer   ssh ok"

# ── SSH keypair ───────────────────────────────────────────────────────────────
$sshDir = Join-Path $env:USERPROFILE ".ssh"
New-Item -ItemType Directory -Force -Path $sshDir | Out-Null
if (-not (Test-Path $SSH_KEY)) {
    Write-Host "Generando clave SSH para el tunel..."
    # Pipe empty lines to accept no-passphrase prompts non-interactively
    "","" | & ssh-keygen -t ed25519 -C "claude-tunnel" -f "$SSH_KEY" -q 2>&1 | Out-Null
    if (-not (Test-Path "$SSH_KEY.pub")) { Write-Err "Fallo al generar clave SSH." }
}
$pubKey  = Get-Content "$SSH_KEY.pub" -Raw
$pcName  = $env:COMPUTERNAME

# ── Claim invite ──────────────────────────────────────────────────────────────
Write-Host "Canjeando codigo de invitacion..."
$claimBody = @{
    invite    = $Invite
    sshPubKey = $pubKey.Trim()
    hostname  = $pcName
} | ConvertTo-Json

try {
    $claim = Invoke-RestMethod "$GATEWAY/claim-invite" -Method POST `
        -ContentType "application/json" -Body $claimBody
} catch {
    Write-Err "No se pudo contactar el gateway: $_"
}

$tunnelPort  = $claim.tunnelPort
$vpsHost     = $claim.vpsHost
$setupSecret = $claim.setupSecret
$tunnelUser  = if ($claim.tunnelUser) { $claim.tunnelUser } else { "claude-tunnel" }

Write-Host "  Puerto asignado: $tunnelPort (como $tunnelUser@$vpsHost)"

# ── AUTH_TOKEN ────────────────────────────────────────────────────────────────
$authBytes = New-Object byte[] 16
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($authBytes)
$AUTH_TOKEN = ($authBytes | ForEach-Object { $_.ToString("x2") }) -join ""

# ── Download server ───────────────────────────────────────────────────────────
Write-Host "Descargando servidor..."
New-Item -ItemType Directory -Force -Path $INSTALL_DIR | Out-Null
$tmpTar = Join-Path $env:TEMP "claude-mobile-server.tar.gz"
Invoke-WebRequest "$GATEWAY/server.tar.gz" -OutFile $tmpTar -UseBasicParsing
tar -xzf $tmpTar -C $INSTALL_DIR --strip-components=1
Remove-Item $tmpTar -Force

Write-Host "Instalando dependencias npm..."
Push-Location $INSTALL_DIR
& npm install --omit=dev --silent
Pop-Location

# Firebase (opcional)
try {
    Invoke-WebRequest "$GATEWAY/firebase-config" `
        -Headers @{ "X-Setup-Secret" = $setupSecret } `
        -OutFile (Join-Path $INSTALL_DIR "firebase-service-account.json") `
        -UseBasicParsing -ErrorAction Stop
    Write-Host "  push notifications: ok"
} catch {
    Write-Host "  push notifications: omitido (sin config firebase)"
}

# ── Write .env ────────────────────────────────────────────────────────────────
@"
PORT=3001
AUTH_TOKEN=$AUTH_TOKEN
GATEWAY_URL=$GATEWAY
SETUP_SECRET=$setupSecret
TUNNEL_PORT=$tunnelPort
"@ | Set-Content (Join-Path $INSTALL_DIR ".env") -Encoding UTF8

# ── SSH tunnel script ─────────────────────────────────────────────────────────
$tunnelPs1 = Join-Path $INSTALL_DIR "claude-tunnel.ps1"
@"
# Keeps the SSH reverse-tunnel alive. Auto-restarted by the Task Scheduler task.
while (`$true) {
    & ssh -N -i "$SSH_KEY" ``
        -o ServerAliveInterval=5 -o ServerAliveCountMax=2 ``
        -o ExitOnForwardFailure=yes -o ConnectTimeout=10 ``
        -o StrictHostKeyChecking=no -o TCPKeepAlive=yes ``
        -R ${tunnelPort}:localhost:3001 "${tunnelUser}@${vpsHost}"
    Start-Sleep 15
}
"@ | Set-Content $tunnelPs1 -Encoding UTF8

# ── Startup folder launchers (no admin required) ─────────────────────────────
Write-Host "Configurando inicio automatico..."

$nodeBin = (Get-Command node).Source
$STARTUP = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"
$noBom   = [System.Text.UTF8Encoding]::new($false)

# ClaudeMobile.vbs — launches node server hidden, no console window
# VBScript/WSH does not support UTF-8 BOM, must save without it
[System.IO.File]::WriteAllText("$STARTUP\ClaudeMobile.vbs", @"
Dim env
Set env = WScript.CreateObject("WScript.Shell").Environment("Process")
env("PORT")         = "3001"
env("AUTH_TOKEN")   = "$AUTH_TOKEN"
env("GATEWAY_URL")  = "$GATEWAY"
env("SETUP_SECRET") = "$setupSecret"
env("TUNNEL_PORT")  = "$tunnelPort"
CreateObject("WScript.Shell").Run """$nodeBin"" ""$INSTALL_DIR\index.js""", 0, False
"@, $noBom)

# ClaudeTunnel.vbs — launches SSH tunnel PowerShell script hidden
[System.IO.File]::WriteAllText("$STARTUP\ClaudeTunnel.vbs", @"
CreateObject("WScript.Shell").Run "powershell.exe -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ""$tunnelPs1""", 0, False
"@, $noBom)

# ── Claude Code hooks ─────────────────────────────────────────────────────────
function Install-Hooks {
    New-Item -ItemType Directory -Force -Path $HOOKS_DIR | Out-Null

    # Hook secret
    $secretFile = Join-Path $HOOKS_DIR ".hook-secret"
    # Wait up to 10s for server to generate it
    for ($i = 0; $i -lt 10; $i++) {
        if (Test-Path $secretFile) { break }
        Start-Sleep 1
    }

    # PowerShell hook script (replaces push.sh on Windows)
    $hookScript = Join-Path $HOOKS_DIR "push.ps1"
    @'
param([string]$Event)
$secretFile = Join-Path $env:USERPROFILE ".claude\hooks\.hook-secret"
$secret = if (Test-Path $secretFile) { Get-Content $secretFile -Raw } else { "" }
$data = $input | Out-String
try {
    Invoke-RestMethod "http://localhost:3001/api/hook/$Event" -Method POST `
        -ContentType "application/json" `
        -Headers @{ "X-Hook-Secret" = $secret.Trim() } `
        -Body $data -ErrorAction SilentlyContinue | Out-Null
} catch {}
exit 0
'@ | Set-Content $hookScript -Encoding UTF8

    # Patch ~/.claude/settings.json
    $d = @{}
    if (Test-Path $SETTINGS) {
        try { $d = Get-Content $SETTINGS -Raw | ConvertFrom-Json -AsHashtable } catch { $d = @{} }
    } else {
        New-Item -ItemType Directory -Force -Path (Split-Path $SETTINGS) | Out-Null
    }
    $cmd = "powershell -NonInteractive -ExecutionPolicy Bypass -File `"$hookScript`""
    foreach ($event in @("Notification", "Stop")) {
        $entry   = @{ hooks = @(@{ type = "command"; command = "$cmd $event" }) }
        $existing = if ($d.ContainsKey($event)) { $d[$event] } else { @() }
        $already  = $existing | Where-Object {
            $_.hooks | Where-Object { $_.command -like "*push.ps1*" }
        }
        if (-not $already) { $d[$event] = @($existing) + @($entry) }
    }
    $d | ConvertTo-Json -Depth 10 | Set-Content $SETTINGS -Encoding UTF8
}

Install-Hooks

# ── Start services now ───────────────────────────────────────────────────────
Write-Host "Iniciando servicios..."

$env:PORT         = "3001"
$env:AUTH_TOKEN   = $AUTH_TOKEN
$env:GATEWAY_URL  = $GATEWAY
$env:SETUP_SECRET = $setupSecret
$env:TUNNEL_PORT  = $tunnelPort

Start-Process $nodeBin -ArgumentList "`"$INSTALL_DIR\index.js`"" `
    -WorkingDirectory $INSTALL_DIR -WindowStyle Hidden
Write-Host "  claude-mobile servidor iniciado"
Start-Sleep 3

Start-Process "powershell.exe" -ArgumentList "-NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$tunnelPs1`"" `
    -WindowStyle Hidden
Write-Host "  claude-tunnel iniciado"

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Green "Instalacion completada!"
Write-Host ""
Write-Bold "Tu contrasena de acceso:"
Write-Host ""
Write-Host "  $AUTH_TOKEN"
Write-Host ""
Write-Host "Ingresa esta contrasena en la app Claude Mobile para conectarte."
Write-Host "Guardala - la necesitaras en cada dispositivo nuevo."
Write-Host "(Los servicios se inician automaticamente al encender el PC)"
