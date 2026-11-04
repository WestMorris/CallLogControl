param([Parameter(Mandatory=$true)][string]$SetupPath, [string]$PreviousSetupPath = '')
$ErrorActionPreference = 'Stop'
$installDir = Join-Path $env:ProgramFiles 'CallLogControl'
$dataDir = Join-Path $env:ProgramData 'CallLogControl'
$analyticsReady = -not $PreviousSetupPath
function Install-Server([string]$Installer = $SetupPath) {
    $process = Start-Process -FilePath $Installer -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/LOG="' + (Join-Path $env:TEMP 'calllog-setup.log') + '"')) -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Instalador devolvio $($process.ExitCode)" }
}
function Check-Services {
    foreach ($name in @('CallLogControlAPI','CallLogControlHTTPS')) {
        $service = Get-CimInstance Win32_Service -Filter "Name='$name'"
        if ($service.State -ne 'Running' -or $service.StartMode -ne 'Auto' -or $service.StartName -ne 'NT AUTHORITY\LocalService') { throw "Estado incorrecto: $name" }
    }
}
function Verify-Existing {
    $verifyArgs = @('--install-dir', $installDir, '--check-existing')
    if (-not $analyticsReady) { $verifyArgs += '--legacy' }
    py -3 (Join-Path $PSScriptRoot 'smoke_verify.py') @verifyArgs
    if ($LASTEXITCODE -ne 0) { throw 'No se conservaron los datos o el servicio no responde.' }
}
try {
    $initialSetup = if ($PreviousSetupPath) { $PreviousSetupPath } else { $SetupPath }
    $invalid = Start-Process -FilePath $initialSetup -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/LANIP=192.0.2.254') -Wait -PassThru
    if ($invalid.ExitCode -eq 0) { throw 'La instalacion fallida no devolvio un error.' }
    Install-Server $initialSetup
    Check-Services
    $configBefore = Get-FileHash (Join-Path $dataDir 'config.json')
    $caBefore = Get-FileHash (Join-Path $dataDir 'caddy\pki\authorities\local\root.crt')
    $firewall = Get-NetFirewallRule -Name CallLogControl-Installer-8443
    if ($firewall.Enabled -ne 'True') { throw 'Falta la regla de firewall.' }
    $acl = Get-Acl $dataDir
    if (-not $acl.AreAccessRulesProtected) { throw 'Los datos heredan permisos generales de ProgramData.' }
    $seedArgs = @('--install-dir', $installDir)
    if (-not $analyticsReady) { $seedArgs += '--legacy' }
    py -3 (Join-Path $PSScriptRoot 'smoke_verify.py') @seedArgs
    if ($LASTEXITCODE -ne 0) { throw 'Fallo la integracion Windows.' }
    # Exercise the actual service recovery policy after an unexpected API crash.
    $api = Get-CimInstance Win32_Service -Filter "Name='CallLogControlAPI'"
    $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($api.ProcessId)" | Where-Object Name -eq 'python.exe'
    if (-not $child) { throw 'No se encontro el proceso de Python del servicio.' }
    Stop-Process -Id $child.ProcessId -Force
    Start-Sleep -Seconds 12
    Check-Services
    Verify-Existing
    $broken = Join-Path $env:TEMP ('calllog-broken-update-' + [guid]::NewGuid().ToString('N'))
    $codeBefore = Get-FileHash (Join-Path $installDir 'server\server.py')
    try {
        New-Item -ItemType Directory -Path (Join-Path $broken 'windows') -Force | Out-Null
        Copy-Item (Join-Path (Split-Path $PSScriptRoot -Parent) 'server') (Join-Path $broken 'server') -Recurse
        Copy-Item (Join-Path $PSScriptRoot 'Update-Server.ps1') (Join-Path $broken 'windows')
        [IO.File]::WriteAllText((Join-Path $broken 'server\server.py'), "raise RuntimeError('Windows rollback test')`n", [Text.UTF8Encoding]::new($false))
        $rejected = $false
        try { & (Join-Path $broken 'windows\Update-Server.ps1') } catch { $rejected = $true }
        if (-not $rejected) { throw 'El actualizador acepto un servidor que falla al arrancar.' }
        Check-Services
        Verify-Existing
        if ((Get-FileHash (Join-Path $installDir 'server\server.py')).Hash -ne $codeBefore.Hash) { throw 'No se recupero el codigo anterior.' }
        if ($PreviousSetupPath -and (Test-Path (Join-Path $installDir 'server\analytics.py'))) { throw 'El rollback anterior conservo un modulo que no existia.' }
        if ((Get-FileHash (Join-Path $dataDir 'config.json')).Hash -ne $configBefore.Hash) { throw 'Cambio la configuracion durante rollback.' }
        if ((Get-FileHash (Join-Path $dataDir 'caddy\pki\authorities\local\root.crt')).Hash -ne $caBefore.Hash) { throw 'Cambio la autoridad durante rollback.' }
    } finally {
        Remove-Item -LiteralPath $broken -Recurse -Force
    }
    & (Join-Path $PSScriptRoot 'Update-Server.ps1')
    $analyticsReady = $true
    Check-Services
    Verify-Existing
    if ((Get-FileHash (Join-Path $dataDir 'config.json')).Hash -ne $configBefore.Hash) { throw 'Cambio la configuracion con el actualizador del servidor.' }
    if ((Get-FileHash (Join-Path $dataDir 'caddy\pki\authorities\local\root.crt')).Hash -ne $caBefore.Hash) { throw 'Cambio la autoridad con el actualizador del servidor.' }
    if (-not (Get-ChildItem (Join-Path $dataDir 'backups') -Filter 'calls.sqlite3' -Recurse)) { throw 'El actualizador no respaldo SQLite.' }
    $codeBefore = Get-FileHash (Join-Path $installDir 'server\server.py')
    $migrating = Join-Path $env:TEMP ('calllog-migrating-update-' + [guid]::NewGuid().ToString('N'))
    try {
        New-Item -ItemType Directory -Path (Join-Path $migrating 'windows') -Force | Out-Null
        Copy-Item (Join-Path $installDir 'server') (Join-Path $migrating 'server') -Recurse
        Copy-Item (Join-Path $PSScriptRoot 'Update-Server.ps1') (Join-Path $migrating 'windows')
        $prefix = @'
import os, sqlite3, time
from pathlib import Path
with sqlite3.connect(Path(os.environ['PROGRAMDATA']) / 'CallLogControl/data/calls.sqlite3') as db:
    first = not db.execute("SELECT 1 FROM sqlite_master WHERE name='smoke_schema_migration'").fetchone()
    if first:
        db.execute("CREATE TABLE smoke_schema_migration (value TEXT NOT NULL)")
        db.execute("INSERT INTO smoke_schema_migration VALUES ('preserve acknowledged test data')")
db.close()
while first:
    time.sleep(1)  # The updater stops this unhealthy first start; the retry sees the marker.

'@
        $migratedCode = Join-Path $migrating 'server\server.py'
        [IO.File]::WriteAllText($migratedCode, $prefix + [IO.File]::ReadAllText($migratedCode), [Text.UTF8Encoding]::new($false))
        $migratedHash = (Get-FileHash $migratedCode).Hash
        $rejection = ''
        try { & (Join-Path $migrating 'windows\Update-Server.ps1') } catch { $rejection = $_.Exception.Message }
        if ($rejection -notlike '*Se conservo el codigo nuevo porque cambio el esquema*') { throw 'No se detecto la migracion durante la recuperacion.' }
        Check-Services
        Verify-Existing
        if ((Get-FileHash (Join-Path $installDir 'server\server.py')).Hash -ne $migratedHash) { throw 'Se restauro codigo anterior sobre una base migrada.' }
        $markerCheck = "import sqlite3, sys; db = sqlite3.connect(sys.argv[1]); assert db.execute('SELECT value FROM smoke_schema_migration').fetchall() == [('preserve acknowledged test data',)]; db.close()"
        py -3 -c $markerCheck (Join-Path $dataDir 'data\calls.sqlite3')
        if ($LASTEXITCODE -ne 0) { throw 'Se perdieron datos de la base migrada.' }
        if ((Get-FileHash (Join-Path $dataDir 'config.json')).Hash -ne $configBefore.Hash) { throw 'Cambio la configuracion al recuperar la migracion.' }
        if ((Get-FileHash (Join-Path $dataDir 'caddy\pki\authorities\local\root.crt')).Hash -ne $caBefore.Hash) { throw 'Cambio la autoridad al recuperar la migracion.' }
        & (Join-Path $PSScriptRoot 'Update-Server.ps1')
        if ((Get-FileHash (Join-Path $installDir 'server\server.py')).Hash -ne $codeBefore.Hash) { throw 'No se restauro el codigo legitimo despues de la prueba.' }
        Check-Services
        Verify-Existing
        py -3 -c $markerCheck (Join-Path $dataDir 'data\calls.sqlite3')
        if ($LASTEXITCODE -ne 0) { throw 'La actualizacion posterior perdio datos de la migracion.' }
    } finally {
        Remove-Item -LiteralPath $migrating -Recurse -Force
    }
    Install-Server
    Check-Services
    Verify-Existing
    if ((Get-FileHash (Join-Path $dataDir 'config.json')).Hash -ne $configBefore.Hash) { throw 'Cambio la configuracion al actualizar.' }
    if ((Get-FileHash (Join-Path $dataDir 'caddy\pki\authorities\local\root.crt')).Hash -ne $caBefore.Hash) { throw 'Cambio la autoridad al actualizar.' }
    $process = Start-Process -FilePath (Join-Path $installDir 'unins000.exe') -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART') -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw 'Fallo la desinstalacion.' }
    foreach ($name in @('CallLogControlAPI','CallLogControlHTTPS')) {
        if (Get-Service -Name $name -ErrorAction SilentlyContinue) { throw 'Quedo un servicio instalado.' }
    }
    if (-not (Test-Path (Join-Path $dataDir 'data\calls.sqlite3'))) { throw 'La desinstalacion borro la base.' }
    if (Test-Path (Join-Path $installDir 'CallLogControlAPI.xml')) { throw 'Quedo la configuracion del servicio dentro de Program Files.' }
    if (Get-NetFirewallRule -Name CallLogControl-Installer-8443 -ErrorAction SilentlyContinue) { throw 'Quedo la regla de firewall.' }
    Install-Server
    Verify-Existing
    Write-Host 'PASS: install, low-privilege automatic services, firewall, crash recovery, upgrade, uninstall/reinstall and data/CA preservation'
} finally {
    foreach ($file in @((Join-Path $dataDir 'setup-error.txt'),(Join-Path $env:TEMP 'calllog-setup.log'))) {
        if (Test-Path $file) { Get-Content $file | Select-Object -Last 80 }
    }
    if (Test-Path (Join-Path $dataDir 'logs')) {
        Get-ChildItem (Join-Path $dataDir 'logs') -File | ForEach-Object { Write-Host $_.Name; Get-Content $_.FullName | Select-Object -Last 30 }
    }
}
