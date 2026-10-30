# Componentes de terceros

La licencia MIT del proyecto se aplica a su código propio. Se conservan las licencias de estos componentes:

- **QR Code generator, Project Nayuki**, MIT. Copia sin modificaciones de `python/qrcodegen.py`, revisión `bcfe1b018cec5f1f91b5705eca5bb4cdd34e9f8d` de https://github.com/nayuki/QR-Code-generator. Su licencia completa está en la cabecera de `server/qrcodegen.py`.
- **Python 3.13.7 embebido para Windows**, Python Software Foundation License y avisos incluidos en `python/LICENSE.txt` del paquete distribuido. Origen: https://www.python.org/ftp/python/3.13.7/.
- **Caddy 2.11.7**, Apache License 2.0. Se incluye su `LICENSE` como `licenses/Caddy-LICENSE.txt` en el instalador. Origen: https://github.com/caddyserver/caddy.
- **WinSW 2.12.0**, MIT. Licencia completa en `windows/WinSW-LICENSE.txt`, también incluida en el instalador. Origen: https://github.com/winsw/winsw.
- **ZXing Android Embedded 4.3.0 y ZXing Core**, Apache License 2.0. Orígenes: https://github.com/journeyapps/zxing-android-embedded y https://github.com/zxing/zxing. Las licencias de las dependencias Android se conservan en el APK.

El instalador se construye con Inno Setup; el compilador no forma parte de la instalación del servidor. Las descargas que se empaquetan en Windows se fijan mediante URL de versión y SHA-256 en `windows/dependencies.json`.
