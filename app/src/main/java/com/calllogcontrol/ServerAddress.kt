package com.calllogcontrol

import java.net.URI

object ServerAddress {
    fun normalize(value: String): String {
        val uri = URI(value.trim())
        require(uri.scheme == "https" && !uri.host.isNullOrBlank() && uri.rawUserInfo == null &&
            uri.rawQuery == null && uri.rawFragment == null && uri.rawPath.orEmpty() in listOf("", "/") &&
            (uri.port == -1 || uri.port in 1..65535)) { "Usa el origen HTTPS del servidor, sin ruta ni credenciales" }
        return uri.toASCIIString().trimEnd('/')
    }
}
