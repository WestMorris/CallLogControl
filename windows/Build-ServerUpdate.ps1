param([string]$OutputDir = '')
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
if (-not $OutputDir) { $OutputDir = Join-Path $repo 'build\windows' }
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
$staging = Join-Path $OutputDir 'server-update-payload'
$zip = Join-Path $OutputDir 'CallLogControl-ServerUpdate-1.1.1.zip'
if (Test-Path $staging) { Remove-Item -LiteralPath $staging -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $staging 'server'), (Join-Path $staging 'windows') | Out-Null
foreach ($name in @('server.py', 'qrcodegen.py', 'web')) {
    Copy-Item -LiteralPath (Join-Path $repo "server\$name") -Destination (Join-Path $staging 'server') -Recurse
}
foreach ($name in @('Update-Server.ps1', 'Update-Server.cmd')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $staging 'windows')
}
foreach ($name in @('LICENSE', 'THIRD_PARTY_NOTICES.md', 'WINDOWS.md')) {
    Copy-Item -LiteralPath (Join-Path $repo $name) -Destination $staging
}
@'
CallLog Control - actualizacion del servidor 1.1.1

Requiere la instalacion Windows con asistente 1.1.0. No es un instalador nuevo.
1. Extraer TODO el ZIP en una carpeta nueva del escritorio del PC servidor.
   No extraer dentro de la instalacion ni de ProgramData.
2. Abrir windows\Update-Server.cmd y aceptar permisos de administrador.
3. Esperar "Servidor actualizado" y recargar http://127.0.0.1:8088/.

No reinstalar Android ni generar nuevos QR. Los equipos conservan su alta.
Se detienen brevemente los servicios y se respalda codigo y SQLite dentro de
C:\ProgramData\CallLogControl\backups. No borrar ProgramData.
Si falla, el script intenta recuperar el codigo anterior y reiniciar servicios.
Las llamadas actuales no se reemplazan con una copia antigua.

CSV: usar la columna inicio (AAAA-MM-DD HH:MM:SS), no inicio_unix_ms.
Comprobar la zona horaria de Windows; zona_horaria_inicio indica el UTC usado.
Si Excel muestra una sola columna: Datos > Desde texto/CSV, UTF-8, coma.
Los filtros Desde/Hasta afectan CSV de la vista. CSV conjunto y los botones CSV
de cada equipo exportan todo el historial correspondiente, sin filtro de fecha.

Mas detalles y opcion -InstallDir en WINDOWS.md.
'@ | Set-Content -LiteralPath (Join-Path $staging 'LEEME.txt') -Encoding UTF8
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -Force
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $(Split-Path $zip -Leaf)" | Set-Content -LiteralPath ($zip + '.sha256') -Encoding ascii
Write-Host "Paquete: $zip"
