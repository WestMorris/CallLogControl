# Servidor y app en la misma Wi-Fi

Esta guía permite usar un teléfono Android físico con un servidor en **Windows, macOS o Linux**, sin dominio público y sin abrir puertos del router. **Docker es opcional**: en Windows puede ejecutarse con Python y Caddy directamente, sin WSL, Hyper-V ni virtualización.

| Tu instalación | Por dónde empezar |
| --- | --- |
| Windows sin Docker | [A. Windows sin Docker](#a-windows-sin-docker) |
| Windows con Docker Compose | [B. Windows con Docker](#b-windows-con-docker) |
| macOS o Linux con Docker Compose | [C. macOS o Linux con Docker](#c-macos-o-linux-con-docker) |
| macOS o Linux sin Docker | [D. macOS o Linux sin Docker](#d-macos-o-linux-sin-docker) |

Después seguir [Conectar Android](#conectar-android), [Panel y CSV](#panel-web-y-exportaciones-csv) y, si se necesita, [Control remoto](#solicitar-sincronización-con-la-app-cerrada).

**Windows: para instalar con pocos pasos, usar el [instalador con servicios automáticos y alta por QR](WINDOWS.md).** Incluye Python y Caddy y configura el firewall. Los pasos de esta página son la alternativa manual para desarrollo o administración avanzada.

## Qué se va a ejecutar

- **Python + SQLite:** guarda los registros y sirve el panel en `http://127.0.0.1:8088`, accesible desde el propio servidor.
- **Caddy:** añade HTTPS para el teléfono en `https://IP_DEL_SERVIDOR:8443`. La app requiere HTTPS; arrancar solo Python no basta para conectarla.
- **App 1.1.0 o posterior:** el alta QR recibe el certificado público de esta instalación; permite usar el mismo APK genérico con distintos servidores. Para el alta manual de versiones anteriores sigue disponible el certificado incluido en un APK debug propio.

En todos los ejemplos, sustituir `192.168.1.100` por la IPv4 real del servidor. PC y teléfono deben poder comunicarse en la misma red; las redes de invitados o el aislamiento de clientes pueden impedirlo. El servidor debe permanecer encendido y sin suspensión. Internet se necesita para descargar herramientas y dependencias; la sincronización local funciona sin Internet.

## A. Windows sin Docker

Los bloques de esta sección son para **PowerShell 5.1 o 7**, no para CMD ni Git Bash. Abrir PowerShell en la carpeta que contiene `README.md`, `gradlew.bat` y `server` (por ejemplo, `Set-Location 'C:\CallLogControl'`). Si se descargó un ZIP de GitHub, extraerlo primero y entrar en su carpeta interior.

### A1. Instalar las herramientas

1. Instalar **Python 3.11 o superior** desde [Python para Windows](https://www.python.org/downloads/windows/). Esta guía usa el lanzador `py -3`; verificarlo con `py -3 --version`. Si solo funciona `python --version`, usar `python` en lugar de `py -3` en los comandos siguientes. No se necesitan `pip`, paquetes adicionales ni un entorno virtual.
2. Descargar **Caddy 2** desde [su sitio oficial](https://caddyserver.com/download), seleccionando Windows y la arquitectura del PC (normalmente amd64 para Intel/AMD de 64 bits). Extraer el ejecutable si viene comprimido y renombrarlo como `caddy.exe`.
3. Para compilar el APK: Android Studio, JDK compatible y SDK indicados en [README.md](README.md#compilar-e-instalar-android). **El servidor no necesita Java ni Android Studio**; el APK se puede compilar en otro equipo usando el certificado de este servidor.

Crear la carpeta local y colocar allí el ejecutable descargado:

```powershell
New-Item -ItemType Directory -Force local-wifi | Out-Null
# Copiar manualmente caddy.exe a local-wifi\caddy.exe y comprobar:
.\local-wifi\caddy.exe version
py -3 --version
```

### A2. Obtener la IP y crear las credenciales

Ejecutar `ipconfig` y buscar la **Dirección IPv4** del adaptador Wi-Fi conectado. No usar la puerta de enlace, una IP de VPN ni `127.0.0.1` como dirección para el teléfono. Se puede reservar esta IP en el router para evitar cambios.

Crear `.env.wifi` **solo la primera vez**. Editar la IP del bloque antes de ejecutarlo:

```powershell
if (Test-Path .env.wifi) { throw '.env.wifi ya existe. Conservarlo; editar la IP si hace falta.' }
$adminToken = py -3 -c "import secrets; print(secrets.token_urlsafe(48))"
if ($LASTEXITCODE -ne 0) { throw 'No se pudo generar la credencial con Python.' }
@("CALLLOG_LAN_IP=192.168.1.100", "CALLLOG_ADMIN_TOKEN=$adminToken") | Set-Content -Encoding ascii .env.wifi
Remove-Variable adminToken
```

`.env.wifi` guarda la clave del administrador, distinta de la de cada teléfono. No compartirlo ni subirlo a Git. Usar una carpeta accesible solo a las personas que administran el servidor: en Windows `chmod` no configura permisos NTFS; revisarlos en **Propiedades → Seguridad**. Lo mismo aplica a `local-wifi` y `server\data`.

### A3. Iniciar Python — ventana 1

Desde la raíz del proyecto, cargar la configuración en **esa ventana** y arrancar la API:

```powershell
Get-Content .env.wifi | ForEach-Object {
    if ($_ -match '^(CALLLOG_LAN_IP|CALLLOG_ADMIN_TOKEN)=(.+)$') {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim(), 'Process')
    }
}
$env:CALLLOG_PUBLIC_URL = "https://$($env:CALLLOG_LAN_IP):8443"
$env:CALLLOG_CA_FILE = Join-Path (Get-Location).Path 'local-wifi\caddy\pki\authorities\local\root.crt'
py -3 server/server.py --data-dir server/data serve --host 127.0.0.1 --port 8088
```

Dejar esta ventana abierta. Debe mostrar `CallLogControl en 127.0.0.1:8088`. Python no lee `.env.wifi` automáticamente: el bloque anterior carga la clave. No cambiar el host a `0.0.0.0`; el acceso desde el teléfono lo atiende Caddy con HTTPS.

### A4. Iniciar HTTPS — ventana 2

Abrir **otra PowerShell**, entrar en la misma carpeta y ejecutar:

```powershell
Get-Content .env.wifi | ForEach-Object {
    if ($_ -match '^(CALLLOG_LAN_IP|CALLLOG_ADMIN_TOKEN)=(.+)$') {
        [Environment]::SetEnvironmentVariable($matches[1], $matches[2].Trim(), 'Process')
    }
}
$env:CALLLOG_TLS_DIR = Join-Path (Get-Location).Path 'local-wifi\caddy'
.\local-wifi\caddy.exe run --config server/Caddyfile.wifi-native --adapter caddyfile
```

Dejar también esta ventana abierta. Se utiliza `Caddyfile.wifi-native`, que apunta a Python en `127.0.0.1:8088`; **no** `Caddyfile.wifi`, que apunta al nombre de servicio Docker `api:8080`.

El almacenamiento de certificados queda en `local-wifi\caddy`, incluso si se reinician los procesos. El certificado público se generará en `local-wifi\caddy\pki\authorities\local\root.crt`. No copiar al APK los archivos `.key`: son claves privadas y deben permanecer en el servidor. Caddy no instala automáticamente esta autoridad en Windows con esta configuración.

### A5. Permitir el acceso en el firewall

Marcar la red Wi-Fi de confianza como **Privada** en Configuración de Windows. Abrir una PowerShell **como administrador** y crear una regla para HTTPS desde la subred local:

```powershell
New-NetFirewallRule -Name CallLogControl-WiFi-8443 -DisplayName 'CallLogControl HTTPS Wi-Fi' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 8443 -Profile Private -RemoteAddress LocalSubnet
```

Se ejecuta una sola vez. No es necesario abrir el puerto 8088 ni desactivar el firewall. En una red corporativa de dominio, pedir al administrador que adapte el perfil y las políticas; una regla solo para `Private` no se aplica a `Domain` ni a `Public`. Referencia: [New-NetFirewallRule de Microsoft](https://learn.microsoft.com/en-us/powershell/module/netsecurity/new-netfirewallrule).

### A6. Verificar y registrar el primer equipo — ventana 3

En otra PowerShell, desde la raíz del proyecto:

```powershell
Invoke-RestMethod http://127.0.0.1:8088/healthz
Test-Path local-wifi\caddy\pki\authorities\local\root.crt
```

Si se usará QR, pasar a A7: no hace falta registrar el equipo por terminal. Para el alta manual con JSON, ejecutar:

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
py -3 -X utf8 server/server.py --data-dir server/data register-device --name 'Ventas 01' | Set-Content -Encoding UTF8 local-wifi\telefono.json
```

La salud debe devolver `status: ok` y la comprobación del certificado `True`. El JSON contiene `device_id`, `name` y `token`. Conservarlo: el servidor guarda solo el hash del token y no puede recuperarlo. No repetir el registro en cada arranque; cada ejecución crea **otro equipo**. PowerShell escribe este JSON en UTF-8; evitar la redirección `>` de PowerShell 5.1, que genera UTF-16.

### A7. Vincular la app o incluir el certificado manualmente

Con la app **1.1.0 o posterior**, abrir el panel y seguir [el alta por QR](WINDOWS.md#agregar-teléfonos-por-qr). No ejecutar el registro de A6 para ese mismo teléfono si se elige QR: el canje ya lo registra con el nombre elegido en el panel. No hace falta copiar un certificado al código ni compilar el APK. La prueba HTTPS siguiente requiere copiar `ca.crt`, pero no es un requisito del alta QR.

Para conservar la configuración manual o usar una app anterior:

Con Caddy ya iniciado, copiar **solo el certificado público**:

```powershell
New-Item -ItemType Directory -Force app\src\debug\res\raw | Out-Null
Copy-Item local-wifi\caddy\pki\authorities\local\root.crt app\src\debug\res\raw\calllog_wifi_ca.crt
Copy-Item app\src\debug\res\raw\calllog_wifi_ca.crt local-wifi\ca.crt
```

Seguir [Compilar e instalar el APK](#compilar-e-instalar-el-apk). Si se compila en otro PC, transferir `root.crt` y colocarlo allí con el nombre `app/src/debug/res/raw/calllog_wifi_ca.crt` **antes** de compilar. No transferir las claves privadas de Caddy.

Para comprobar HTTPS desde Windows sin instalar la autoridad en todo el sistema, puede usarse Python con el certificado copiado (sustituir la IP):

```powershell
py -3 -c "import ssl, urllib.request; ctx=ssl.create_default_context(cafile='local-wifi/ca.crt'); print(urllib.request.urlopen('https://192.168.1.100:8443/healthz', context=ctx, timeout=5).read().decode())"
```

### A8. Detener y volver a arrancar

Para detener, pulsar **Ctrl+C** en las ventanas de Python y Caddy. Cerrar esas ventanas también interrumpe el servidor. Para volver a arrancar, repetir **A3 y A4**, desde la misma carpeta, conservando `.env.wifi`, `server\data` y `local-wifi\caddy`. No hace falta registrar otra vez el teléfono, generar claves ni recompilar.

Estos pasos arrancan procesos en primer plano para la prueba; **no instalan servicios ni inicio automático**. Después de reiniciar Windows hay que volver a arrancarlos. Para funcionamiento permanente, configurar ambos procesos bajo una cuenta dedicada con rutas absolutas y proteger sus datos; Caddy documenta [opciones de servicio Windows](https://caddyserver.com/docs/running#windows-service).

## B. Windows con Docker

Si el equipo no admite Docker, usar **A**. Para esta alternativa se necesita Docker Compose operativo. Usar PowerShell desde la raíz del proyecto.

1. Crear `local-wifi` con `New-Item -ItemType Directory -Force local-wifi` y `.env.wifi` como en **A2** (Python se usa para generar la clave). No arrancar los procesos de A3/A4 al mismo tiempo: los puertos coinciden.
2. Arrancar los contenedores y copiar el certificado:

```powershell
New-Item -ItemType Directory -Force local-wifi\public | Out-Null
docker compose --env-file .env.wifi -f compose.wifi.yaml up -d --build
New-Item -ItemType Directory -Force app\src\debug\res\raw | Out-Null
docker compose --env-file .env.wifi -f compose.wifi.yaml cp https:/data/caddy/pki/authorities/local/root.crt app/src/debug/res/raw/calllog_wifi_ca.crt
Copy-Item app\src\debug\res\raw\calllog_wifi_ca.crt local-wifi\ca.crt
Copy-Item local-wifi\ca.crt local-wifi\public\root.crt
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
docker compose --env-file .env.wifi -f compose.wifi.yaml exec -T api python server.py register-device --name 'Ventas 01' | Set-Content -Encoding UTF8 local-wifi\telefono.json
```

Esperar a que Caddy genere `root.crt`; si la copia falla porque aún no existe, revisar los logs y repetir la copia. Permitir TCP 8443 en el firewall de Windows como en **A5**. Seguir [Compilar e instalar el APK](#compilar-e-instalar-el-apk). Los datos y la autoridad se guardan en volúmenes Docker, no en `server\data` ni `local-wifi\caddy`.

## C. macOS o Linux con Docker

Los comandos de esta sección son para una terminal `sh`/Bash/Zsh. Se necesita Docker Compose y Python 3.11+ para generar la clave.

Consultar la IPv4 Wi-Fi con `ipconfig getifaddr en0` en macOS (la interfaz puede variar), o `ip -4 addr` en Linux. Desde la raíz del proyecto, **crear `.env.wifi` solo si no existe; conservarlo en instalaciones existentes**:

```sh
cp -n .env.wifi.example .env.wifi
chmod 600 .env.wifi
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
```

Editar `.env.wifi`: poner la IPv4 en `CALLLOG_LAN_IP` y la clave generada en `CALLLOG_ADMIN_TOKEN`, sin comillas ni espacios alrededor de `=`. **No sobrescribir un `.env.wifi` existente.** Después:

```sh
mkdir -p local-wifi/public app/src/debug/res/raw
docker compose --env-file .env.wifi -f compose.wifi.yaml up -d --build
chmod 700 local-wifi
docker compose --env-file .env.wifi -f compose.wifi.yaml cp \
  https:/data/caddy/pki/authorities/local/root.crt app/src/debug/res/raw/calllog_wifi_ca.crt
cp app/src/debug/res/raw/calllog_wifi_ca.crt local-wifi/ca.crt
cp local-wifi/ca.crt local-wifi/public/root.crt
chmod 755 local-wifi/public
chmod 644 local-wifi/public/root.crt
docker compose --env-file .env.wifi -f compose.wifi.yaml exec -T api \
  python server.py register-device --name 'Ventas 01' > local-wifi/telefono.json
chmod 600 local-wifi/telefono.json
```

Si Caddy aún no generó el certificado, revisar logs y repetir la copia. Permitir TCP 8443 desde la LAN en el firewall del sistema y seguir [Compilar e instalar el APK](#compilar-e-instalar-el-apk).

## D. macOS o Linux sin Docker

Instalar Python 3.11+ y el binario nativo de Caddy 2 desde [sus instrucciones oficiales](https://caddyserver.com/docs/install). No hacen falta paquetes Python externos. Crear y editar `.env.wifi` como al inicio de **C**, sin ejecutar los comandos Docker.

En la primera terminal, desde la raíz del proyecto:

```sh
mkdir -p local-wifi app/src/debug/res/raw
chmod 700 local-wifi
set -a
. ./.env.wifi
set +a
export CALLLOG_PUBLIC_URL="https://${CALLLOG_LAN_IP}:8443"
export CALLLOG_CA_FILE="$PWD/local-wifi/caddy/pki/authorities/local/root.crt"
python3 server/server.py --data-dir server/data serve --host 127.0.0.1 --port 8088
```

En otra terminal, desde la misma carpeta:

```sh
set -a
. ./.env.wifi
set +a
export CALLLOG_TLS_DIR="$PWD/local-wifi/caddy"
caddy run --config server/Caddyfile.wifi-native --adapter caddyfile
```

Dejar ambos procesos abiertos. En una tercera terminal, después de que se genere `root.crt`:

```sh
cp local-wifi/caddy/pki/authorities/local/root.crt app/src/debug/res/raw/calllog_wifi_ca.crt
cp app/src/debug/res/raw/calllog_wifi_ca.crt local-wifi/ca.crt
python3 server/server.py --data-dir server/data register-device --name 'Ventas 01' > local-wifi/telefono.json
chmod 600 local-wifi/telefono.json
```

Permitir TCP 8443 desde la LAN en el firewall y seguir la compilación. Para detener, Ctrl+C en ambos procesos; para reiniciar, repetir solo los bloques de arranque, conservando la configuración, los datos y la autoridad. No se configura inicio automático.

## Compilar e instalar el APK

**Con QR no es necesario compilar:** descargar el APK genérico 1.2.0 de [la entrega](https://github.com/WestMorris/CallLogControl/releases/tag/v1.2.0), instalar y vincular desde el panel. Los teléfonos ya vinculados conservan su alta al instalar encima con la misma firma. Si se compila desde el código, también puede usarse QR sin incorporar ningún certificado al APK, incluso en una variante `release` firmada por el administrador.

Para la **configuración manual con una autoridad local**, el archivo `app/src/debug/res/raw/calllog_wifi_ca.crt` debe existir antes de compilar. En una copia limpia de GitHub no está: es propio de cada servidor. Sin él y sin alta QR, la app solo confía en autoridades del sistema y rechazará este HTTPS local. La variante `release` no incluye esa confianza de depuración; sí permite la confianza específica configurada mediante QR.

1. Abrir el proyecto en Android Studio y dejar que configure `local.properties` con la ruta del SDK de **ese PC**. No copiar ese archivo desde macOS a Windows.
2. En SDK Manager, instalar **Android SDK Platform 36** y **Build Tools 35.0.0** y aceptar sus licencias. Usar un JDK compatible con Gradle 8.13, versión 17 o superior (por ejemplo, 21). Configurar también `JAVA_HOME` si se compila desde una PowerShell externa a Android Studio.
3. Compilar la variante `debug`. En equipos con poca RAM, cerrar el emulador y usar un teléfono físico; el servidor puede estar en otro PC.

PowerShell en Windows:

```powershell
.\gradlew.bat :app:assembleDebug --max-workers=2
```

macOS/Linux:

```sh
./gradlew :app:assembleDebug --max-workers=2
```

El APK queda en `app/build/outputs/apk/debug/app-debug.apk` (versión actual **1.2.0**). Transferirlo al teléfono e instalarlo manualmente. Autorizar la instalación desde esa fuente cuando Android lo solicite. Para actualizar, instalar primero el servidor 1.2.0 y después el APK encima con la misma firma, sin desinstalar ni volver a vincular. Referencia: [compilación por línea de comandos Android](https://developer.android.com/build/building-cmdline).

**Actualizaciones desde otro PC:** Android exige la misma clave de firma. Cada PC suele generar su propio `debug.keystore`; un APK compilado en Windows puede no instalarse encima del anterior compilado en macOS. Conservar y usar la clave original de forma privada para actualizar sin borrar datos. No desinstalar como primer recurso: elimina el historial local y la configuración. Antes de una reinstalación deliberada, sincronizar y exportar lo necesario. Actualizar solo la app no traslada al nuevo servidor los registros que ya estaban en el anterior.

El certificado público y los archivos privados de instalación están excluidos de Git. No hace falta instalar una autoridad en los ajustes del teléfono ni aceptar certificados inválidos. Un navegador sin esta autoridad puede mostrar un aviso en la URL HTTPS aunque el APK propio funcione correctamente.

## Conectar Android

La vía recomendada es [generar un QR y escanearlo desde la app](WINDOWS.md#agregar-teléfonos-por-qr). En Docker, copiar el certificado público a `local-wifi/public/root.crt` como se indica arriba y actualizar el servicio con el `compose.wifi.yaml` nuevo. La API recibe solo esa carpeta pública, sin las claves privadas de Caddy. En la instalación nativa manual, los bloques de arranque ya configuran la URL y la ruta de la autoridad para generar QR.

Para conservar el alta manual con JSON y token:

1. Abrir la app y crear o introducir la contraseña local.
2. Pulsar **Autorizar acceso al historial**, aceptar el aviso y los permisos, y pulsar **Actualizar**. Se importa el historial disponible; no se graba audio.
3. Abrir `local-wifi/telefono.json` en el PC. En **Servidor**, introducir `https://192.168.1.100:8443` usando la IP real, y el valor `token` en **Credencial del equipo**. No usar `device_id` ni la clave del administrador. No añadir `/v1` a la URL.
4. Pulsar **Guardar y activar** y después **Sincronizar**. Esperar a que aparezca **Último envío** y los pendientes lleguen a cero.
5. Hacer una llamada de prueba, terminarla y pulsar **Actualizar → Sincronizar**. Confirmar la llamada en el panel.

La app `debug` admite credenciales de prueba de 10 caracteres; `release` exige al menos 32. Conservar las credenciales aleatorias que genera el servidor y emitir una distinta para cada teléfono. Su nombre visible se asigna con `register-device --name`, no con el UUID. Reutilizar un token mezcla los teléfonos bajo el mismo equipo.

## Panel web y exportaciones CSV

La tabla muestra **SIM / línea** y permite elegir **25, 50, 100 o 200 registros por página**, con botones Anterior/Siguiente y rango/total. Los CSV exportan todos los registros que coincidan con el filtro, independientemente de la página o cantidad seleccionada. App y CSV incluyen el nombre e identificador de la cuenta de cada llamada que Android proporciona; sin ese dato aparece **No disponible**. Actualizar e importar de nuevo puede completar llamadas antiguas que sigan en el historial Android. Los CSV añaden `sim_o_linea`, `cuenta_telefonica_id` y `cuenta_telefonica_componente` al final de las columnas existentes.

En el propio servidor, abrir **[http://127.0.0.1:8088](http://127.0.0.1:8088)**. Introducir el valor `CALLLOG_ADMIN_TOKEN` de `.env.wifi`, sin el nombre de la variable. La credencial del teléfono no sirve para administrar.

El panel muestra equipos, cantidad de llamadas, último contacto, última sincronización, solicitudes y el historial paginado. Permite seleccionar un equipo y filtrar con **Desde / Hasta → Aplicar**; ambos días se incluyen según la zona horaria del navegador. **Limpiar** quita las fechas. **CSV de la vista** descarga todos los registros que coincidan con equipo y fechas, aunque haya varias páginas. **CSV conjunto** y el botón **CSV** de cada equipo descargan el historial completo, sin el filtro de fechas. Se actualiza cada cinco segundos. Al recargar o salir se pierde la sesión: la clave se mantiene solo en memoria del navegador.

La dirección `127.0.0.1` es del equipo donde se abre el navegador: no permite acceder al PC desde el teléfono. Para el panel en otro PC se puede usar `https://IP_DEL_SERVIDOR:8443`, configurando correctamente la confianza de su autoridad local en ese navegador. No enviar la clave administrativa a través de HTTP por la LAN.

### CSV con PowerShell, sin depender de curl

La descarga desde el panel es la opción más sencilla. Si se necesita terminal, desde la raíz del proyecto (sirve con y sin Docker):

```powershell
Get-Content .env.wifi | ForEach-Object {
    if ($_ -match '^CALLLOG_ADMIN_TOKEN=(.+)$') {
        $env:CALLLOG_ADMIN_TOKEN = $matches[1].Trim()
    }
}
$headers = @{ Authorization = "Bearer $env:CALLLOG_ADMIN_TOKEN" }
$deviceId = (Get-Content -Raw -Encoding UTF8 local-wifi\telefono.json | ConvertFrom-Json).device_id
Invoke-RestMethod -Uri http://127.0.0.1:8088/v1/devices -Headers $headers
Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8088/v1/export.csv?device_id=$deviceId" -Headers $headers -OutFile local-wifi\llamadas-telefono.csv
Invoke-WebRequest -UseBasicParsing -Uri http://127.0.0.1:8088/v1/export.csv -Headers $headers -OutFile local-wifi\llamadas-todos.csv
```

Estos comandos usan HTTP **solo en el loopback del propio servidor**. Evitan el alias `curl` de PowerShell 5.1 y los problemas de confianza TLS del almacén de Windows. `-OutFile` guarda los bytes del CSV sin convertir su codificación.

### CSV con macOS/Linux

Desde la raíz del proyecto:

```sh
set -a
. ./.env.wifi
set +a
CALLLOG_DEVICE_ID=$(python3 -c 'import json; print(json.load(open("local-wifi/telefono.json"))["device_id"])')
curl --fail -H "Authorization: Bearer ${CALLLOG_ADMIN_TOKEN}" \
  'http://127.0.0.1:8088/v1/devices'
curl --fail -H "Authorization: Bearer ${CALLLOG_ADMIN_TOKEN}" \
  "http://127.0.0.1:8088/v1/export.csv?device_id=${CALLLOG_DEVICE_ID}" \
  --output local-wifi/llamadas-telefono.csv
curl --fail -H "Authorization: Bearer ${CALLLOG_ADMIN_TOKEN}" \
  'http://127.0.0.1:8088/v1/export.csv' --output local-wifi/llamadas-todos.csv
```

Abrir los CSV con Excel, LibreOffice o Numbers. Contienen UTF-8 con BOM; `equipo_id` y `equipo` identifican el origen de cada fila. Si Excel muestra todo en una columna, importar **Desde texto/CSV** seleccionando UTF-8 y separador coma. Los archivos se actualizan al volver a descargarlos. Un CSV individual puede tener solo cabecera si todavía no llegaron llamadas; el conjunto incluye todos los equipos, también los de prueba existentes.

La columna **`inicio`** contiene una fecha legible en formato **año-mes-día hora:minuto:segundo**, por ejemplo `2026-11-04 09:30:00`. **`zona_horaria_inicio`** indica su desplazamiento UTC. Se usa la zona horaria del servidor; comprobar la configuración de Windows. La columna antigua `inicio_unix_ms` conserva el valor técnico original y no debe interpretarse como fecha de Excel. Si la detección regional de Excel deja `inicio` como texto, importar esa columna como fecha/hora con orden año-mes-día ([guía de importación de Microsoft](https://support.microsoft.com/en-us/excel/get-started/import-or-export-text-txt-or-csv-files)).

## Solicitar sincronización con la app cerrada

1. Desbloquear la app y conservar la URL y credencial que ya funcionan.
2. Pulsar **Activar control remoto**, aceptar el aviso, permitir notificaciones y la excepción de optimización de batería que solicita Android.
3. Verificar la notificación permanente **Control remoto activo**. Ya puede cerrarse la pantalla de la app.
4. En el panel, pulsar **Solicitar sincronización** en la fila del equipo. Pasa de **Pendiente** a **Completada** cuando el teléfono importa el historial y el servidor confirma los envíos.

Funciona tanto con Python nativo como con Docker. Mantiene una conexión HTTPS de espera larga para responder sin esperar al intervalo periódico de unos 15 minutos. Consume más batería y requiere Wi-Fi accesible y el servidor encendido. Puede detenerse desde la app o desde la notificación.

**Forzar detención** impide responder hasta abrir de nuevo la app. Después de reiniciar el teléfono hay que reactivar el control remoto. Algunos fabricantes requieren permitir inicio automático o actividad sin restricciones. Si no está activo, la solicitud puede quedar pendiente hasta el siguiente contacto de la app. El prototipo admite ocho canales remotos simultáneos; medir carga antes de ampliar la flota.

## Añadir y revocar equipos

No hace falta crear un servidor ni otro APK por cada teléfono: los que usan el mismo servidor pueden compartir el APK y su certificado, pero **cada uno debe tener su token**. El nombre del registro permite distinguirlos en el panel y los CSV. La interfaz permite dar de alta desde **Agregar teléfono por QR**. El nombre se elige allí o desde la terminal; todavía no hay renombrado de equipos.

Windows sin Docker (guardar cada JSON con nombre distinto):

```powershell
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
py -3 -X utf8 server/server.py --data-dir server/data register-device --name 'Soporte 02' | Set-Content -Encoding UTF8 local-wifi\soporte-02.json
py -3 server/server.py --data-dir server/data revoke-device ID_DEL_EQUIPO
```

macOS/Linux sin Docker:

```sh
python3 server/server.py --data-dir server/data register-device --name 'Soporte 02' > local-wifi/soporte-02.json
chmod 600 local-wifi/soporte-02.json
python3 server/server.py --data-dir server/data revoke-device ID_DEL_EQUIPO
```

Con Docker, los siguientes comandos son de una sola línea y sirven en ambas terminales. Guardar el JSON devuelto de forma privada (en PowerShell usar `| Set-Content -Encoding UTF8 local-wifi\soporte-02.json`):

```text
docker compose --env-file .env.wifi -f compose.wifi.yaml exec -T api python server.py register-device --name "Soporte 02"
docker compose --env-file .env.wifi -f compose.wifi.yaml exec -T api python server.py revoke-device ID_DEL_EQUIPO
```

Sustituir `ID_DEL_EQUIPO` por su UUID del panel o JSON. La revocación conserva las llamadas pero impide nuevos accesos de ese teléfono. Los comandos nativos deben usar **el mismo `--data-dir`** que el proceso servidor; otra carpeta crea otra base y sus credenciales no funcionarán.

## Operación, datos y cambios de IP

### Con Docker

Comandos de una sola línea, válidos también en PowerShell:

```text
docker compose --env-file .env.wifi -f compose.wifi.yaml ps
docker compose --env-file .env.wifi -f compose.wifi.yaml logs --tail 50
docker compose --env-file .env.wifi -f compose.wifi.yaml stop
docker compose --env-file .env.wifi -f compose.wifi.yaml start
```

Para aplicar cambios de configuración o actualizar: `docker compose --env-file .env.wifi -f compose.wifi.yaml up -d --build`. Este despliegue usa volúmenes separados del despliegue con dominio público de `compose.yaml`. **No usar `down -v`**: elimina llamadas y la autoridad de certificados.

### Sin Docker

Conservar `server/data` (SQLite), `local-wifi/caddy` (autoridad, certificados y claves privadas), `.env.wifi` y los JSON de equipos. Para una copia sencilla y consistente, detener primero **ambos procesos** y copiar esas carpetas y archivos a un destino privado. Si se necesita backup con Python en ejecución, usar la API de backup de SQLite: copiar solo `calls.sqlite3` puede omitir registros del WAL. Proteger también las claves de firma Android que se usen para futuras actualizaciones.

Una instalación nueva sin esos datos crea una base y una autoridad distintas. **Descargar el código de GitHub no copia la instalación anterior**: los datos y secretos están excluidos. Esta guía prepara un servidor nuevo; no migra los volúmenes Docker de otra máquina.

### Si cambia la IP del servidor

1. Editar `CALLLOG_LAN_IP` en `.env.wifi`.
2. Sin Docker, reiniciar Python y Caddy repitiendo sus bloques de arranque para que ambos lean la nueva IP, también al generar QR. Con Docker, ejecutar `docker compose --env-file .env.wifi -f compose.wifi.yaml up -d`.
3. Cambiar la URL en **Servidor** de la app y guardar. Si se vinculó por QR, marcar **Conservar certificado actual al cambiar la IP** y dejar la credencial vacía para mantener el mismo equipo. Si se mantiene un campo `server_url` adicional en algún JSON privado, actualizarlo también.

Caddy emitirá un certificado para la nueva IP. Si se conserva la misma autoridad (`local-wifi/caddy` o el volumen de Caddy), **no hace falta recompilar el APK**. Si se pierde o recrea esa autoridad, con QR hay que volver a vincular (se crea otro equipo y el historial anterior permanece en el servidor); con configuración manual hay que actualizar la confianza del certificado. Reservar la IP en el router evita este cambio habitual.

## Diagnóstico

| Síntoma | Qué comprobar |
| --- | --- |
| `py` no se reconoce | Instalar Python y reabrir PowerShell. Si `python --version` funciona, sustituir `py -3` por `python`. |
| Se abre Microsoft Store al ejecutar `python` | Usar el Python instalado o `py -3`; revisar los alias de ejecución de aplicaciones de Windows. |
| `Define CALLLOG_ADMIN_TOKEN…` | Ejecutar el bloque de carga de `.env.wifi` en la misma ventana que Python. La clave debe tener al menos 32 caracteres. |
| `address already in use` / `WinError 10048` | Otro proceso o despliegue ocupa 8088/8443. No iniciar Docker y los procesos nativos a la vez. |
| `WinError 10049` / no puede asignar la dirección | `CALLLOG_LAN_IP` no pertenece a la interfaz actual. Revisar `ipconfig` y reiniciar Caddy con la IP correcta. |
| No abre `http://127.0.0.1:8088` | Comprobar que Python sigue abierto o que el contenedor API está sano. Ejecutar `/healthz` antes de probar Android. |
| Panel funciona pero Android no conecta | Comprobar Caddy, URL `https://IP:8443`, firewall, misma red, VPN, aislamiento y suspensión del servidor. Desde otro Windows se puede usar `Test-NetConnection IP_DEL_SERVIDOR -Port 8443`. |
| Caddy devuelve `502` | Python no está iniciado en 8088 o se usó el Caddyfile de Docker en la instalación nativa. |
| Error de certificado Android | Copiar la autoridad de **ese servidor** antes de compilar `debug`; comprobar la hora del teléfono y que la URL coincide con la IP. No desactivar TLS. |
| No aparece `root.crt` | Revisar la salida de Caddy, su IP y `CALLLOG_TLS_DIR`; en Docker revisar logs y esperar su generación antes de copiarlo. |
| `JAVA_HOME` / SDK no encontrados | Configurar el JDK, Android SDK 36 y Build Tools; abrir el proyecto en Android Studio para generar `local.properties`. En Windows usar `.\gradlew.bat`. |
| No instala encima de la app anterior | Revisar la firma: el nuevo PC puede tener otro `debug.keystore`. Conservar la clave original; no borrar datos como primer paso. |
| `401` | Teléfono: copiar `token` sin comillas/espacios. Panel: usar `CALLLOG_ADMIN_TOKEN`. Confirmar que el equipo se registró en la base correcta y no está revocado. |
| CSV vacío | Ver conteo del equipo en el panel, autorizar historial e importar y sincronizar desde Android; descargar otra vez el CSV. |
| Permiso de llamadas denegado | Android puede exigir que el instalador o MDM permita `READ_CALL_LOG`. La instalación manual no elimina esa restricción. |
| Solicitud remota pendiente | Comprobar notificación de control remoto, batería sin restricciones, Wi-Fi y servidor encendido. Tras reiniciar el teléfono hay que reactivarlo. |

## Alcance de la verificación

La prueba anterior con Docker verificó Android → HTTPS LAN → Caddy → Python → SQLite, confirmaciones, reenvíos sin duplicados, CSV individual y conjunto y aislamiento de credenciales. El control remoto se midió en un emulador Android 14 con la actividad cerrada y Doze forzado; su tiempo no garantiza la respuesta de todos los teléfonos.

El **30/10/2026** se verificó también Python + Caddy **sin Docker en macOS**, con una base ficticia y puertos temporales: HTTPS validado con su autoridad local, panel, dos equipos, reenvíos sin duplicados, CSV individual y conjunto, solicitud remota y confirmación y aislamiento de credenciales. Se comprobó que el Caddyfile conserva rutas Windows con espacios y barras invertidas. Pasaron las once pruebas HTTP del servidor.

No se ejecutó PowerShell ni se instaló en hardware Windows durante esta verificación. El firewall, las herramientas y el flujo con el teléfono deben comprobarse en el PC de destino; la prueba nativa de macOS no sustituye esa comprobación.

Referencias: [HTTPS local de Caddy](https://caddyserver.com/docs/automatic-https), [almacenamiento de Caddy](https://caddyserver.com/docs/caddyfile/options#storage) y [confianza de certificados en Android](https://developer.android.com/privacy-and-security/security-config).
