param([Parameter(Mandatory=$true)][string]$SetupPath)
$ErrorActionPreference = 'Stop'
$installDir = Join-Path $env:ProgramFiles 'CallLogControl'
$dataDir = Join-Path $env:ProgramData 'CallLogControl'
function Install-Server {
    $process = Start-Process -FilePath $SetupPath -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',('/LOG="' + (Join-Path $env:TEMP 'calllog-setup.log') + '"')) -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Instalador devolvio $($process.ExitCode)" }
}
function Check-Services {
    foreach ($name in @('CallLogControlAPI','CallLogControlHTTPS')) {
        $service = Get-CimInstance Win32_Service -Filter "Name='$name'"
        if ($service.State -ne 'Running' -or $service.StartMode -ne 'Auto' -or $service.StartName -ne 'NT AUTHORITY\LocalService') { throw "Estado incorrecto: $name" }
    }
}
function Verify-Existing {
    py -3 (Join-Path $PSScriptRoot 'smoke_verify.py') --install-dir $installDir --check-existing
    if ($LASTEXITCODE -ne 0) { throw 'No se conservaron los datos o el servicio no responde.' }
}
try {
    $invalid = Start-Process -FilePath $SetupPath -ArgumentList @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/LANIP=192.0.2.254') -Wait -PassThru
    if ($invalid.ExitCode -eq 0) { throw 'La instalacion fallida no devolvio un error.' }
    Install-Server
    Check-Services
    $configBefore = Get-FileHash (Join-Path $dataDir 'config.json')
    $caBefore = Get-FileHash (Join-Path $dataDir 'caddy\pki\authorities\local\root.crt')
    $firewall = Get-NetFirewallRule -Name CallLogControl-Installer-8443
    if ($firewall.Enabled -ne 'True') { throw 'Falta la regla de firewall.' }
    $acl = Get-Acl $dataDir
    if (-not $acl.AreAccessRulesProtected) { throw 'Los datos heredan permisos generales de ProgramData.' }
    py -3 (Join-Path $PSScriptRoot 'smoke_verify.py') --install-dir $installDir
    if ($LASTEXITCODE -ne 0) { throw 'Fallo la integracion Windows.' }
    # Exercise the actual service recovery policy after an unexpected API crash.
    $api = Get-CimInstance Win32_Service -Filter "Name='CallLogControlAPI'"
    $child = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($api.ProcessId)" | Where-Object Name -eq 'python.exe'
    if (-not $child) { throw 'No se encontro el proceso de Python del servicio.' }
    Stop-Process -Id $child.ProcessId -Force
    Start-Sleep -Seconds 12
    Check-Services
    Verify-Existing
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
