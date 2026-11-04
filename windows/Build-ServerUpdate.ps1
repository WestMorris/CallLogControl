param([string]$OutputDir = '')
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
if (-not $OutputDir) { $OutputDir = Join-Path $repo 'build\windows' }
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
$staging = Join-Path $OutputDir 'server-update-payload'
$zip = Join-Path $OutputDir 'CallLogControl-ServerUpdate-1.2.0.zip'
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
CallLog Control - actualizacion del servidor 1.2.0

Requiere la instalacion Windows con asistente 1.1.0 o posterior. No es un instalador nuevo.
1. Extraer TODO el ZIP en una carpeta nueva del escritorio del PC servidor.
   No extraer dentro de la instalacion ni de ProgramData.
2. Abrir windows\Update-Server.cmd y aceptar permisos de administrador.
3. Esperar "Servidor actualizado" y recargar http://127.0.0.1:8088/.

Despues del servidor, instalar el APK 1.2.0 encima del anterior con la misma firma.
No desinstalar Android ni generar nuevos QR. Los equipos conservan su alta.
Abrir la app, autorizar nombres SIM/linea si se desea y Actualizar > Sincronizar.
Se detienen brevemente los servicios y se respalda codigo y SQLite dentro de
C:\ProgramData\CallLogControl\backups. No borrar ProgramData.
Si falla sin cambio de esquema, intenta recuperar el codigo anterior.
Si el esquema cambio, conserva el nuevo para evitar una version incompatible.
En ambos casos intenta reiniciar servicios e informa el resultado.
Las llamadas actuales no se reemplazan con una copia antigua.

CSV: usar la columna inicio (AAAA-MM-DD HH:MM:SS), no inicio_unix_ms.
Comprobar la zona horaria de Windows; zona_horaria_inicio indica el UTC usado.
Si Excel muestra una sola columna: Datos > Desde texto/CSV, UTF-8, coma.
Los filtros Desde/Hasta afectan CSV de la vista. CSV conjunto y los botones CSV
de cada equipo exportan todo el historial correspondiente, sin filtro de fecha.
Panel: selector de 25, 50, 100 o 200 registros por pagina.
SIM/linea: cuenta de cada llamada; No disponible si Android no aporta el dato.

Mas detalles y opcion -InstallDir en WINDOWS.md.
'@ | Set-Content -LiteralPath (Join-Path $staging 'LEEME.txt') -Encoding UTF8
Compress-Archive -Path (Join-Path $staging '*') -DestinationPath $zip -Force
$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $(Split-Path $zip -Leaf)" | Set-Content -LiteralPath ($zip + '.sha256') -Encoding ascii
Write-Host "Paquete: $zip"
