# Claude Mobile — Windows uninstaller

$INSTALL_DIR = "$env:USERPROFILE\.local\share\claude-mobile"
$SSH_KEY      = "$env:USERPROFILE\.ssh\claude_tunnel"
$HOOKS_DIR    = "$env:USERPROFILE\.claude\hooks"
$SETTINGS     = "$env:USERPROFILE\.claude\settings.json"
$STARTUP      = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup"

Write-Host "Claude Mobile - desinstalador" -ForegroundColor White
Write-Host ""
$confirm = Read-Host "Esto eliminara todos los archivos y servicios de Claude Mobile. Continuar? [s/N]"
if ($confirm -notmatch '^[sS]$') { Write-Host "Cancelado."; exit 0 }
Write-Host ""

# Stop and remove scheduled tasks
foreach ($task in @("ClaudeMobile","ClaudeTunnel","ClaudeWatchdog")) {
    $t = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
    if ($t) {
        Stop-ScheduledTask  -TaskName $task -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "  $task`: eliminado"
    }
}

# Remove startup folder VBS launchers
foreach ($vbs in @("ClaudeMobile.vbs","ClaudeTunnel.vbs","ClaudeWatchdog.vbs")) {
    $p = Join-Path $STARTUP $vbs
    if (Test-Path $p) { Remove-Item $p -Force; Write-Host "  $vbs`: eliminado" }
}

# Kill any running processes from install dir
Get-Process -Name node,ssh,powershell -ErrorAction SilentlyContinue | ForEach-Object {
    try {
        $cmd = (Get-WmiObject Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
        if ($cmd -and ($cmd -match [regex]::Escape($INSTALL_DIR) -or $cmd -match "watchdog|claude-tunnel")) {
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
    } catch {}
}

# Remove install directory
if (Test-Path $INSTALL_DIR) {
    Remove-Item $INSTALL_DIR -Recurse -Force
    Write-Host "  $INSTALL_DIR`: eliminado"
}

# Remove SSH tunnel key
foreach ($f in @($SSH_KEY, "$SSH_KEY.pub")) {
    if (Test-Path $f) { Remove-Item $f -Force; Write-Host "  $f`: eliminado" }
}

# Remove hooks
foreach ($f in @("push.ps1",".hook-secret")) {
    $p = Join-Path $HOOKS_DIR $f
    if (Test-Path $p) { Remove-Item $p -Force }
}
Write-Host "  hooks: eliminados"

# Patch settings.json — remove push.ps1 entries from Notification and Stop
if (Test-Path $SETTINGS) {
    try {
        $raw = Get-Content $SETTINGS -Raw | ConvertFrom-Json
        $changed = $false
        foreach ($event in @("Notification","Stop")) {
            if ($raw.PSObject.Properties[$event]) {
                $before = @($raw.$event)
                $after  = @($before | Where-Object {
                    -not ($_.hooks | Where-Object { $_.command -like "*push.ps1*" })
                })
                if ($after.Count -ne $before.Count) {
                    $raw.$event = $after
                    $changed = $true
                }
            }
        }
        if ($changed) {
            $raw | ConvertTo-Json -Depth 10 | Set-Content $SETTINGS -Encoding UTF8
            Write-Host "  settings.json: hooks eliminados"
        }
    } catch {}
}

Write-Host ""
Write-Host "Desinstalacion completa." -ForegroundColor Green
Write-Host ""
Write-Host "Nota: si quieres revocar el acceso al VPS, usa el panel admin:"
Write-Host "  https://claude.polymitia.tech/admin/"
