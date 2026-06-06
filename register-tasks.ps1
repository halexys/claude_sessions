# Claude Mobile - Register system startup tasks (requires Administrator)
# Usage: Right-click -> "Run as administrator"
#        or: Start-Process powershell -Verb RunAs -ArgumentList "-File register-tasks.ps1"

param(
    [string]$UserProfile = $env:USERPROFILE,
    [string]$Username    = $env:USERNAME,
    [string]$Domain      = $env:USERDOMAIN
)

$INSTALL_DIR  = "$UserProfile\.local\share\claude-mobile"
$tunnelPs1    = "$INSTALL_DIR\claude-tunnel.ps1"
$watchdogPs1  = "$INSTALL_DIR\watchdog.ps1"
$psBin        = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

if (-not (Test-Path "$INSTALL_DIR\.env")) {
    Write-Host "ERROR: $INSTALL_DIR\.env not found. Run install.ps1 first." -ForegroundColor Red
    Read-Host "Press Enter to exit"; exit 1
}

# Find node.exe
$nodeBin = $null
$candidates = @(
    "C:\Program Files\nodejs\node.exe",
    "C:\Program Files (x86)\nodejs\node.exe",
    "$UserProfile\AppData\Roaming\nvm\current\node.exe"
)
foreach ($c in $candidates) { if (Test-Path $c) { $nodeBin = $c; break } }
if (-not $nodeBin) {
    $found = Get-Command node -ErrorAction SilentlyContinue
    if ($found) { $nodeBin = $found.Source }
}
if (-not $nodeBin) {
    Write-Host "ERROR: node.exe not found. Add Node.js to system PATH." -ForegroundColor Red
    Read-Host "Press Enter to exit"; exit 1
}

$principal = New-ScheduledTaskPrincipal -UserId "$Domain\$Username" -LogonType S4U -RunLevel Highest
$svcStart  = New-ScheduledTaskTrigger -AtStartup

# ClaudeMobile — node server
$act1 = New-ScheduledTaskAction -Execute $nodeBin `
    -Argument "`"$INSTALL_DIR\index.js`"" -WorkingDirectory $INSTALL_DIR
$set1 = New-ScheduledTaskSettingsSet `
    -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "ClaudeMobile" `
    -Action $act1 -Trigger $svcStart -Settings $set1 -Principal $principal -Force | Out-Null
Write-Host "ClaudeMobile: OK"

# ClaudeTunnel — SSH reverse-tunnel keepalive
$act2 = New-ScheduledTaskAction -Execute $psBin `
    -Argument "-NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$tunnelPs1`""
$set2 = New-ScheduledTaskSettingsSet `
    -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "ClaudeTunnel" `
    -Action $act2 -Trigger $svcStart -Settings $set2 -Principal $principal -Force | Out-Null
Write-Host "ClaudeTunnel: OK"

# ClaudeWatchdog — relanza los otros dos si se caen (loop cada 5 min)
$act3 = New-ScheduledTaskAction -Execute $psBin `
    -Argument "-NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdogPs1`""
$set3 = New-ScheduledTaskSettingsSet `
    -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "ClaudeWatchdog" `
    -Action $act3 -Trigger $svcStart -Settings $set3 -Principal $principal -Force | Out-Null
Write-Host "ClaudeWatchdog: OK"

# Remove startup-folder VBS launchers (superseded by these tasks)
$startup = "$UserProfile\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup"
$vbs1 = Join-Path $startup "ClaudeMobile.vbs"
$vbs2 = Join-Path $startup "ClaudeTunnel.vbs"
$vbs3 = Join-Path $startup "ClaudeWatchdog.vbs"
if (Test-Path $vbs1) { Remove-Item $vbs1 -Force }
if (Test-Path $vbs2) { Remove-Item $vbs2 -Force }
if (Test-Path $vbs3) { Remove-Item $vbs3 -Force }

# Start all now
Start-ScheduledTask -TaskName "ClaudeMobile"
Start-Sleep 3
Start-ScheduledTask -TaskName "ClaudeTunnel"
Start-Sleep 1
Start-ScheduledTask -TaskName "ClaudeWatchdog"

Write-Host ""
Write-Host "Los servicios arrancaran automaticamente al encender el PC (sin necesidad de iniciar sesion)." -ForegroundColor Green
Read-Host "Press Enter to close"
