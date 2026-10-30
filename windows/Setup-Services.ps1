param(
    [Parameter(Mandatory=$true)][string]$InstallDir,
    [string]$LanIP = 'auto',
    [switch]$StopOnly,
    [switch]$Remove
)
$ErrorActionPreference = 'Stop'
$dataDir = Join-Path $env:ProgramData 'CallLogControl'
$serviceNames = @('CallLogControlHTTPS', 'CallLogControlAPI')
foreach ($name in $serviceNames) {
    $service = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($service -and $service.Status -ne 'Stopped') {
        Stop-Service -Name $name -Force
        $service.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
    }
}
if ($StopOnly) { exit 0 }
if ($Remove) {
    foreach ($name in $serviceNames) {
        if (Get-Service -Name $name -ErrorAction SilentlyContinue) {
            & (Join-Path $InstallDir "$name.exe") uninstall
            if ($LASTEXITCODE -ne 0) { throw "No se pudo quitar el servicio $name" }
        }
    }
    Remove-NetFirewallRule -Name CallLogControl-Installer-8443 -ErrorAction SilentlyContinue
    # Data and the CA survive uninstall so reinstalling never silently erases calls.
    exit 0
}
New-Item -ItemType Directory -Force $dataDir | Out-Null
try {
    if ((Get-Item $dataDir).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'La carpeta de datos no puede ser un enlace o junction.' }
    if (Get-ChildItem $dataDir -Force -Recurse | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'La carpeta de datos contiene un enlace o junction; revisa su contenido antes de instalar.' }
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true, $false)
    $acl.SetOwner([Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
    foreach ($entry in @(@('S-1-5-18','FullControl'),@('S-1-5-32-544','FullControl'),@('S-1-5-19','Modify'))) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($entry[0]), $entry[1], 'ContainerInherit,ObjectInherit', 'None', 'Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -Path $dataDir -AclObject $acl
    if (Get-ChildItem $dataDir -Force | Select-Object -First 1) {
        & icacls.exe (Join-Path $dataDir '*') /reset /T /Q | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'No se pudieron proteger los archivos existentes con permisos NTFS.' }
    }
    New-Item -ItemType Directory -Force (Join-Path $dataDir 'logs') | Out-Null
    if ($LanIP -eq 'auto') {
        $network = Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.IPv4Address } | Sort-Object { $_.NetIPv4Interface.InterfaceMetric } | Select-Object -First 1
        if (-not $network) { throw 'No se detecto una interfaz IPv4 con puerta de enlace. Conecta el Wi-Fi o indica la IP en el instalador.' }
        $LanIP = @($network.IPv4Address)[0].IPAddress
    }
    $ip = $null
    if (-not [Net.IPAddress]::TryParse($LanIP, [ref]$ip) -or $ip.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'La IP debe ser IPv4.' }
    if (-not (Get-NetIPAddress -AddressFamily IPv4 | Where-Object IPAddress -eq $LanIP)) { throw 'La IP indicada no pertenece a este PC.' }
    foreach ($port in @(8088,8443)) {
        if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { throw "El puerto $port esta ocupado. Deten la instalacion manual o Docker antes de continuar." }
    }
    $python = Join-Path $InstallDir 'python\python.exe'
    & $python (Join-Path $InstallDir 'windows\runtime.py') configure --data-dir $dataDir --lan-ip $LanIP
    if ($LASTEXITCODE -ne 0) { throw 'No se pudo preparar la configuracion. Los datos anteriores se conservaron.' }
    function Escape-Xml([string]$value) { [Security.SecurityElement]::Escape($value) }
    foreach ($name in @('CallLogControlAPI', 'CallLogControlHTTPS')) {
        if ($name -eq 'CallLogControlAPI') {
            $executable = $python
            $arguments = '"' + (Join-Path $InstallDir 'windows\runtime.py') + '" serve --data-dir "' + $dataDir + '"'
            $environment = ''
        } else {
            $executable = Join-Path $InstallDir 'caddy.exe'
            $arguments = 'run --config "' + (Join-Path $InstallDir 'server\Caddyfile.wifi-native') + '" --adapter caddyfile'
            $environment = '<env name="CALLLOG_LAN_IP" value="' + (Escape-Xml $LanIP) + '"/><env name="CALLLOG_TLS_DIR" value="' + (Escape-Xml (Join-Path $dataDir 'caddy')) + '"/>'
        }
        $xml = @"
<service>
  <id>$name</id><name>$name</name><description>CallLog Control - servidor empresarial local sin Docker</description>
  <executable>$(Escape-Xml $executable)</executable><arguments>$(Escape-Xml $arguments)</arguments>
  <workingdirectory>$(Escape-Xml $InstallDir)</workingdirectory>
  <env name="PYTHONUTF8" value="1"/><env name="PYTHONDONTWRITEBYTECODE" value="1"/>$environment
  <serviceaccount><domain>NT AUTHORITY</domain><user>LocalService</user></serviceaccount>
  <startmode>Automatic</startmode><stoptimeout>15sec</stoptimeout><onfailure action="restart" delay="5 sec"/>
  <logpath>$(Escape-Xml (Join-Path $dataDir 'logs'))</logpath><log mode="roll-by-size"><sizeThreshold>1024</sizeThreshold><keepFiles>4</keepFiles></log>
</service>
"@
        [IO.File]::WriteAllText((Join-Path $InstallDir "$name.xml"), $xml, [Text.UTF8Encoding]::new($false))
        $wrapper = Join-Path $InstallDir "$name.exe"
        if (-not (Get-Service -Name $name -ErrorAction SilentlyContinue)) {
            & $wrapper install
            if ($LASTEXITCODE -ne 0) { throw "No se pudo instalar $name" }
        }
        & $wrapper start
        if ($LASTEXITCODE -ne 0) { throw "No se pudo iniciar $name" }
    }
    Remove-NetFirewallRule -Name CallLogControl-Installer-8443 -ErrorAction SilentlyContinue
    New-NetFirewallRule -Name CallLogControl-Installer-8443 -DisplayName 'CallLogControl HTTPS Wi-Fi' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8443 -Profile Private,Domain -RemoteAddress LocalSubnet -Program (Join-Path $InstallDir 'caddy.exe') | Out-Null
    $healthy = $false
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        try {
            $health = Invoke-RestMethod http://127.0.0.1:8088/healthz -TimeoutSec 2
            if ($health.status -eq 'ok' -and (Test-Path (Join-Path $dataDir 'caddy\pki\authorities\local\root.crt'))) { $healthy = $true; break }
        } catch { }
        Start-Sleep -Seconds 1
    }
    if (-not $healthy) { throw 'Los servicios no quedaron disponibles. Revisa los logs en ProgramData\CallLogControl\logs.' }
    Remove-Item (Join-Path $dataDir 'setup-error.txt') -ErrorAction SilentlyContinue
} catch {
    $_.Exception.Message | Set-Content -Encoding UTF8 (Join-Path $dataDir 'setup-error.txt')
    Write-Error $_
    exit 1
}
