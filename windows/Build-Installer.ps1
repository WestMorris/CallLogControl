param([string]$OutputDir = '', [string]$Iscc = '')
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repo = Split-Path $PSScriptRoot -Parent
if (-not $OutputDir) { $OutputDir = Join-Path $repo 'build\windows' }
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
$downloads = Join-Path $OutputDir 'downloads'
$payload = Join-Path $OutputDir 'payload'
New-Item -ItemType Directory -Force $downloads | Out-Null
if (Test-Path $payload) { Remove-Item -Recurse -Force $payload }
New-Item -ItemType Directory -Force $payload | Out-Null
$manifest = Get-Content -Raw (Join-Path $PSScriptRoot 'dependencies.json') | ConvertFrom-Json
foreach ($item in $manifest) {
    $file = Join-Path $downloads $item.name
    if (-not (Test-Path $file)) { Invoke-WebRequest -UseBasicParsing -Uri $item.url -OutFile $file }
    if ((Get-FileHash $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256) {
        throw "Hash incorrecto de $($item.name). Elimina la descarga y vuelve a intentar; no se empaqueto."
    }
}
Expand-Archive (Join-Path $downloads 'python-3.13.7-embed-amd64.zip') (Join-Path $payload 'python')
Expand-Archive (Join-Path $downloads 'caddy_2.11.7_windows_amd64.zip') (Join-Path $payload 'caddy-distribution')
Copy-Item (Join-Path $payload 'caddy-distribution\caddy.exe') $payload
New-Item -ItemType Directory -Force (Join-Path $payload 'licenses') | Out-Null
Copy-Item (Join-Path $payload 'caddy-distribution\LICENSE') (Join-Path $payload 'licenses\Caddy-LICENSE.txt')
Remove-Item -Recurse (Join-Path $payload 'caddy-distribution')
foreach ($name in @('CallLogControlAPI','CallLogControlHTTPS')) { Copy-Item (Join-Path $downloads 'WinSW-x64.exe') (Join-Path $payload "$name.exe") }
# Embedded Python uses an isolated search path; explicitly include the application modules.
Add-Content -Encoding ascii (Join-Path $payload 'python\python313._pth') '..\server'
New-Item -ItemType Directory -Force (Join-Path $payload 'server'),(Join-Path $payload 'windows') | Out-Null
foreach ($name in @('server.py','qrcodegen.py','analytics.py','Caddyfile.wifi-native')) { Copy-Item (Join-Path $repo "server\$name") (Join-Path $payload 'server') }
Copy-Item -Recurse (Join-Path $repo 'server\web') (Join-Path $payload 'server')
foreach ($name in @('runtime.py','Setup-Services.ps1','Open-Admin.ps1')) { Copy-Item (Join-Path $PSScriptRoot $name) (Join-Path $payload 'windows') }
Copy-Item (Join-Path $repo 'LICENSE') $payload
Copy-Item (Join-Path $repo 'THIRD_PARTY_NOTICES.md') (Join-Path $payload 'licenses')
Copy-Item (Join-Path $PSScriptRoot 'WinSW-LICENSE.txt') (Join-Path $payload 'licenses')
if (-not $Iscc) { $Iscc = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe' }
if (-not (Test-Path $Iscc)) { throw 'Instala Inno Setup 6 o indica -Iscc con la ruta de ISCC.exe.' }
& $Iscc "/DPayloadDir=$payload" "/DOutputDir=$OutputDir" (Join-Path $PSScriptRoot 'CallLogControl.iss')
if ($LASTEXITCODE -ne 0) { throw 'Inno Setup no pudo compilar el instalador.' }
