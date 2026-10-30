# Prueba por Wi-Fi

El servidor local se configura como **`https://IP_DE_LA_MAC:8443`**; por ejemplo, `https://192.168.1.100:8443`. La Mac y el teléfono deben estar en la misma red Wi-Fi, con comunicación entre equipos permitida. No hace falta publicar un dominio ni abrir puertos en el router.

## Preparar una instalación nueva

Requiere Docker Compose, Python 3.11+ y las herramientas Android indicadas en README.md. Desde la raíz del proyecto:

```sh
cp .env.wifi.example .env.wifi
chmod 600 .env.wifi
# Consultar la IP de la Mac y ponerla en CALLLOG_LAN_IP dentro de .env.wifi:
ipconfig getifaddr en0
# Generar una clave y copiarla a CALLLOG_ADMIN_TOKEN dentro de .env.wifi:
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
docker compose --env-file .env.wifi -f compose.wifi.yaml up -d --build
mkdir -p local-wifi app/src/debug/res/raw
chmod 700 local-wifi
docker compose --env-file .env.wifi -f compose.wifi.yaml cp \
  https:/data/caddy/pki/authorities/local/root.crt app/src/debug/res/raw/calllog_wifi_ca.crt
cp app/src/debug/res/raw/calllog_wifi_ca.crt local-wifi/ca.crt
./gradlew :app:assembleDebug
```

El certificado de tu servidor se incluye únicamente en tu APK de depuración y queda excluido de Git. Sin ese archivo, una copia limpia del repositorio compila usando solo las autoridades del sistema; ese APK no confía todavía en el servidor Wi-Fi local. La variante `release` usa siempre la confianza normal de Android.

Registrar el primer teléfono y guardar su credencial de forma privada:

```sh
docker compose --env-file .env.wifi -f compose.wifi.yaml exec -T api \
  python server.py register-device --name "Ventas 01" > local-wifi/telefono.json
chmod 600 local-wifi/telefono.json
```

El JSON contiene `device_id`, `name` y `token`. La URL de la app es `https://IP_DE_LA_MAC:8443`, usando la IP configurada en `.env.wifi`.

## Conectar el teléfono

1. Instalar `app/build/outputs/apk/debug/app-debug.apk` (**versión 1.0.3**) encima de la versión anterior, sin desinstalar. Usar este APK nuevo: incluye el certificado público de la autoridad local del servidor únicamente para la variante `debug`.
2. Abrir la app y crear o introducir la contraseña local.
3. Autorizar el historial y pulsar **Actualizar**. Se importa el historial disponible del teléfono; no se graba audio.
4. Abrir en la Mac `local-wifi/telefono.json`. Introducir la URL `https://IP_DE_LA_MAC:8443` en **Servidor** y copiar el valor `token` en **Credencial del equipo**. No usar la credencial de administrador.
5. Pulsar **Guardar y activar**, y después **Sincronizar**. Dejar el teléfono conectado al Wi-Fi y esperar a que aparezca **Último envío** y los pendientes lleguen a cero.
6. Hacer una llamada de prueba, terminarla y pulsar **Actualizar → Sincronizar** para comprobar el ciclo sin esperar a la tarea periódica.

La app `debug` admite credenciales de prueba de 10 caracteres; `release` exige al menos 32. El servidor genera credenciales aleatorias por defecto: conservarlas para cada equipo. La credencial de administrador es independiente y no debe introducirse en el teléfono.

El certificado se valida dentro de la app: no hace falta instalar una autoridad en los ajustes del teléfono ni aceptar certificados inválidos. Un navegador normal mostrará un aviso al abrir esta URL porque no tiene esa autoridad local instalada; eso no significa que el APK nuevo vaya a rechazarla. La variante `release` conserva la confianza normal del sistema, sin esta autoridad de prueba.

## Panel web del servidor

Desde esta Mac, abrir **[http://127.0.0.1:8088](http://127.0.0.1:8088)**. Introducir el valor `CALLLOG_ADMIN_TOKEN` de `.env.wifi`. La clave del teléfono no sirve para administrar el servidor.

El panel muestra equipos, cantidad de llamadas, último contacto, última sincronización, solicitudes pendientes o completadas y el historial paginado. Permite filtrar por equipo y descargar su CSV o el CSV conjunto. La pantalla se actualiza cada cinco segundos mientras está abierta. Al recargar o salir se pierde la sesión; la clave no se guarda en el almacenamiento del navegador.

El puerto 8088 solo está publicado en el loopback de la Mac. La app sigue utilizando HTTPS por Wi-Fi en el puerto 8443. Para acceder al panel desde otra máquina se puede usar el origen HTTPS, con la autoridad local correctamente instalada en el navegador de esa máquina.

## Solicitar sincronización con la app cerrada

1. Instalar el APK 1.0.3 y desbloquear la app. Mantener la URL y credencial que ya funcionan.
2. Pulsar **Activar control remoto**, aceptar el aviso y permitir las notificaciones y la excepción de optimización de batería que solicita Android.
3. Verificar la notificación permanente **Control remoto activo**. Ya puede cerrarse la pantalla de la app.
4. En el panel web, pulsar **Solicitar sincronización** en la fila de ese equipo. El estado pasa a **Pendiente** y después a **Completada**, una vez que el teléfono importó el historial y el servidor confirmó los envíos.

Este modo mantiene un canal HTTPS de espera larga: el servidor puede responder en cuanto se pulsa el botón, sin esperar 15 minutos ni usar Firebase o Internet. Mantiene la CPU disponible para responder y consume más batería que el modo periódico. La conexión debe seguir accesible por Wi-Fi. Se detiene desde **Detener control remoto** o la acción **Detener** de la notificación.

**Forzar detención** impide responder hasta volver a abrir la app. Después de reiniciar el teléfono hay que reactivar el modo remoto. Algunos fabricantes requieren además permitir inicio automático o actividad sin restricciones; validar el modelo real antes de prometer un tiempo de respuesta. Si el control remoto no está activo, las solicitudes siguen pendientes y la tarea periódica puede recogerlas más tarde.

El prototipo admite hasta ocho canales remotos de espera simultáneos y reserva capacidad para el panel y los envíos. Antes de ampliar la flota, dimensionar este límite y medir carga.

## Exportar los registros recibidos

Desde esta carpeta en la terminal de la Mac, cargar las variables privadas sin imprimirlas:

```sh
set -a
source .env.wifi
set +a
```

Ver equipos, IDs y cantidad de llamadas recibidas:

```sh
curl --fail --cacert local-wifi/ca.crt \
  -H "Authorization: Bearer ${CALLLOG_ADMIN_TOKEN}" \
  "https://${CALLLOG_LAN_IP}:8443/v1/devices"
```

CSV del teléfono físico:

```sh
CALLLOG_DEVICE_ID=$(python3 -c 'import json; print(json.load(open("local-wifi/telefono.json"))["device_id"])')
curl --fail --cacert local-wifi/ca.crt \
  -H "Authorization: Bearer ${CALLLOG_ADMIN_TOKEN}" \
  "https://${CALLLOG_LAN_IP}:8443/v1/export.csv?device_id=${CALLLOG_DEVICE_ID}" \
  --output local-wifi/llamadas-telefono.csv
```

CSV de todos los equipos, incluidos los perfiles de prueba:

```sh
curl --fail --cacert local-wifi/ca.crt \
  -H "Authorization: Bearer ${CALLLOG_ADMIN_TOKEN}" \
  "https://${CALLLOG_LAN_IP}:8443/v1/export.csv" \
  --output local-wifi/llamadas-todos.csv
```

Abrir los CSV con Excel o Numbers. `equipo_id` y `equipo` identifican el origen de cada fila. El archivo se actualiza al ejecutar la descarga, no automáticamente al abrirlo. Un CSV individual puede contener solo la cabecera mientras ese equipo no haya enviado llamadas.

## Administrar Docker

Este despliegue usa `compose.wifi.yaml`, `.env.wifi` y volúmenes separados del despliegue con dominio público de `compose.yaml`.

```sh
# Arrancar o actualizar
docker compose --env-file .env.wifi -f compose.wifi.yaml up -d --build

# Estado y logs
docker compose --env-file .env.wifi -f compose.wifi.yaml ps
docker compose --env-file .env.wifi -f compose.wifi.yaml logs --tail 50

# Detener conservando datos y certificados
docker compose --env-file .env.wifi -f compose.wifi.yaml stop

# Volver a iniciar
docker compose --env-file .env.wifi -f compose.wifi.yaml start
```

No usar `down -v`: elimina los volúmenes, incluyendo llamadas y la autoridad de certificados. La API también publica el panel únicamente en el loopback de la Mac; desde Wi-Fi se publica HTTPS en `192.168.1.100:8443`.

Para añadir otro teléfono, emitir una credencial distinta y conservar su JSON de forma privada:

```sh
docker compose --env-file .env.wifi -f compose.wifi.yaml exec -T api \
  python server.py register-device --name "Ventas 02"
```

Para revocarlo sin borrar sus llamadas:

```sh
docker compose --env-file .env.wifi -f compose.wifi.yaml exec -T api \
  python server.py revoke-device ID_DEL_EQUIPO
```

Los archivos `.env.wifi` y `local-wifi/` están excluidos de Git. El certificado público incluido en el APK no contiene la clave privada ni credenciales. La clave de la autoridad permanece en el volumen de Caddy.

## Si cambia la IP de la Mac

Conviene reservar `192.168.1.100` para esta Mac en el router. Para consultar la IP Wi-Fi:

```sh
ipconfig getifaddr en0
```

Si cambia, actualizar `CALLLOG_LAN_IP` en `.env.wifi` y ejecutar `docker compose --env-file .env.wifi -f compose.wifi.yaml up -d`. Después cambiar la URL en la app. Caddy emitirá un certificado para la nueva IP; mientras se conserve el volumen de su autoridad, no hace falta recompilar el APK. Si se mantiene un campo `server_url` adicional en el JSON de conexión, actualizarlo también.

Si se elimina el volumen de Caddy, la autoridad cambia. Extraer su nuevo certificado y volver a compilar e instalar el APK:

```sh
docker compose --env-file .env.wifi -f compose.wifi.yaml cp \
  https:/data/caddy/pki/authorities/local/root.crt app/src/debug/res/raw/calllog_wifi_ca.crt
cp app/src/debug/res/raw/calllog_wifi_ca.crt local-wifi/ca.crt
./gradlew :app:assembleDebug
```

## Diagnóstico

- **No conecta:** comprobar misma Wi-Fi, Mac encendida, Docker en ejecución y URL con `https` y puerto `8443`. Una red de invitados o el aislamiento de clientes puede impedir que los equipos se comuniquen. Revisar firewall o VPN si sigue fallando; no es necesario abrir el router hacia Internet.
- **Error de certificado o mínimo 32 caracteres:** instalar el APK Wi-Fi 1.0.3, comprobar la hora del teléfono y conservar la autoridad de Caddy. No desactivar la validación TLS.
- **401 o credencial inválida:** copiar `token` sin comillas ni espacios desde el JSON del teléfono. Cada equipo tiene su propia credencial.
- **CSV vacío:** revisar primero la cantidad de llamadas de ese equipo en `/v1/devices`. Importar y sincronizar en la app antes de volver a descargar.
- **Permiso denegado:** Android puede exigir que el instalador/MDM permita `READ_CALL_LOG`. La instalación manual no elimina esta restricción.

Comprobación HTTPS desde la Mac:

```sh
curl --fail --cacert local-wifi/ca.crt "https://192.168.1.100:8443/healthz"
```

## Verificación realizada

El 30/10/2026 se arrancaron los contenedores y se verificó el flujo real **Android → HTTPS por la IP LAN → Caddy → API Docker → SQLite** usando dos perfiles ficticios en un emulador Android 14. Se verificaron confirmaciones en Room, reenvíos sin duplicados, CSV individuales, CSV conjunto y denegación de exportación administrativa usando una credencial de teléfono. Los dos perfiles de prueba figuran con el prefijo `[PRUEBA]`.

Los CSV, credenciales e informes locales se guardan en `local-wifi/` y no forman parte del repositorio público. El estado del teléfono físico debe comprobarse por separado después de la instalación manual.

La prueba del modo remoto con la actividad cerrada y Doze profundo forzado completó la solicitud en 0,756 segundos en el emulador, con la excepción de batería activa. El informe está en `local-wifi/remote-verification.json`. El panel y sus CSV también se probaron en un navegador con datos ficticios. Esta medición no garantiza el mismo resultado en todos los teléfonos.

Referencias: [certificados locales de Caddy](https://caddyserver.com/docs/automatic-https), [confianza de certificados solo en depuración Android](https://developer.android.com/privacy-and-security/security-config).
