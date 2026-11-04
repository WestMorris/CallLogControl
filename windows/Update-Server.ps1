param([string]$InstallDir = '')
$ErrorActionPreference = 'Stop'
$principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $arguments = '-NoProfile -ExecutionPolicy Bypass -NoExit -File "' + $PSCommandPath + '"'
    if ($InstallDir) { $arguments += ' -InstallDir "' + $InstallDir + '"' }
    Start-Process powershell.exe -Verb RunAs -ArgumentList $arguments
    exit
}
$dataDir = Join-Path $env:ProgramData 'CallLogControl'
$source = Join-Path (Split-Path $PSScriptRoot -Parent) 'server'
$names = @('server.py', 'qrcodegen.py', 'analytics.py', 'web')
$services = @('CallLogControlHTTPS', 'CallLogControlAPI')
foreach ($name in $services) {
    $service = Get-CimInstance Win32_Service -Filter "Name='$name'"
    if (-not $service) { throw "No esta instalado el servicio $name. Usa el instalador completo para una instalacion nueva." }
    $image = [Environment]::ExpandEnvironmentVariables($service.PathName)
    if ($image -match '^"([^"]+)"') { $executable = $Matches[1] }
    elseif ($image -match '^(\S+)') { $executable = $Matches[1] }
    else { throw "Ruta del servicio $name no reconocida." }
    if ((Split-Path $executable -Leaf) -ne "$name.exe") { throw "El servicio $name no corresponde al instalador de CallLog Control." }
    $serviceDir = Split-Path $executable -Parent
    if (-not $InstallDir) { $InstallDir = $serviceDir }
    if ([IO.Path]::GetFullPath($InstallDir).TrimEnd('\') -ne [IO.Path]::GetFullPath($serviceDir).TrimEnd('\')) {
        throw "Los servicios no pertenecen a la carpeta indicada: $InstallDir"
    }
}
$target = Join-Path $InstallDir 'server'
if ([IO.Path]::GetFullPath($source).TrimEnd('\') -eq [IO.Path]::GetFullPath($target).TrimEnd('\')) {
    throw 'Extrae el ZIP en una carpeta distinta de la instalacion antes de actualizar.'
}
$python = Join-Path $InstallDir 'python\python.exe'
$backupRoot = Join-Path $dataDir 'backups'
foreach ($path in @($source, $InstallDir, $target, $python, (Join-Path $dataDir 'config.json'), (Join-Path $dataDir 'data\calls.sqlite3'))) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Falta un archivo o carpeta necesario: $path" }
}
foreach ($path in @($InstallDir, $dataDir, $backupRoot, $source, $target, (Join-Path $dataDir 'data'))) {
    if (Test-Path -LiteralPath $path) {
        if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "No se permiten enlaces o junctions: $path" }
    }
}
foreach ($path in @($source, $target, (Join-Path $dataDir 'data'))) {
    if (Get-ChildItem -LiteralPath $path -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw "No se permiten enlaces o junctions: $path" }
}
foreach ($name in $names) {
    if (-not (Test-Path -LiteralPath (Join-Path $source $name))) { throw "El paquete esta incompleto: $name" }
}
foreach ($name in @('index.html', 'panel.js', 'panel.css', 'analytics.js', 'analytics.css')) {
    if (-not (Test-Path -LiteralPath (Join-Path $source "web\$name"))) { throw "El paquete esta incompleto: web\$name" }
}
& $python -c "import pathlib, sys; [compile(pathlib.Path(p).read_text(encoding='utf-8'), p, 'exec') for p in sys.argv[1:]]" (Join-Path $source 'server.py') (Join-Path $source 'qrcodegen.py') (Join-Path $source 'analytics.py')
if ($LASTEXITCODE -ne 0) { throw 'El codigo del paquete no se pudo validar; el servidor sigue sin cambios.' }
function Stop-Server {
    foreach ($name in $services) {
        Stop-Service -Name $name -Force
        (Get-Service $name).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
}
function Start-Api {
    Start-Service CallLogControlAPI
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            if ((Invoke-RestMethod http://127.0.0.1:8088/healthz -TimeoutSec 2).status -eq 'ok') { return }
        } catch { }
        Start-Sleep -Seconds 1
    }
    throw 'La API no respondio despues de actualizar.'
}
function Replace-Code([string]$from) {
    foreach ($name in $names) {
        $destination = Join-Path $target $name
        if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
        # Installations before 1.4.0 have no analytics module in their rollback copy.
        if ($name -eq 'analytics.py' -and -not (Test-Path -LiteralPath (Join-Path $from $name))) { continue }
        Copy-Item -LiteralPath (Join-Path $from $name) -Destination $destination -Recurse
    }
}
function Get-DatabaseSchema {
    $version = & $python -c "import sqlite3, sys; db = sqlite3.connect(sys.argv[1]); print(db.execute('PRAGMA schema_version').fetchone()[0]); db.close()" (Join-Path $dataDir 'data\calls.sqlite3')
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo comprobar el esquema de SQLite.' }
    return [int]$version
}
$backup = Join-Path $backupRoot ('server-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
$replacing = $false
try {
    Stop-Server
    $schemaBefore = Get-DatabaseSchema
    New-Item -ItemType Directory -Path $backup -Force | Out-Null
    Copy-Item -LiteralPath $target -Destination (Join-Path $backup 'server') -Recurse
    Copy-Item -LiteralPath (Join-Path $dataDir 'data') -Destination (Join-Path $backup 'data') -Recurse
    $replacing = $true
    Replace-Code $source
    Start-Api
    Start-Service CallLogControlHTTPS
    (Get-Service CallLogControlHTTPS).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    Write-Host 'Servidor actualizado. Se conservaron los equipos, llamadas, claves, certificados e IP.'
    Write-Host "Respaldo protegido: $backup"
    Write-Host 'Abre http://127.0.0.1:8088/ y recarga el panel.'
} catch {
    $failure = $_.Exception.Message
    $recovery = 'servidor actual'
    $schemaNotice = ''
    try {
        Stop-Server
        if ($replacing) {
            if ((Get-DatabaseSchema) -eq $schemaBefore) {
                Replace-Code (Join-Path $backup 'server')
                $recovery = 'servidor anterior'
            } else {
                $recovery = 'servidor nuevo'
                $schemaNotice = ' Se conservo el codigo nuevo porque cambio el esquema de SQLite.'
            }
        }
        # Keep the live database: restoring an old copy could erase acknowledged calls.
        Start-Api
        Start-Service CallLogControlHTTPS
        (Get-Service CallLogControlHTTPS).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    } catch {
        throw "Actualizacion fallida: $failure.$schemaNotice Tampoco se pudo reiniciar el ${recovery}: $($_.Exception.Message). Respaldo: $backup"
    }
    throw "Actualizacion fallida: $failure.$schemaNotice Se reinicio el $recovery; los datos actuales se conservaron. Respaldo: $backup"
}
