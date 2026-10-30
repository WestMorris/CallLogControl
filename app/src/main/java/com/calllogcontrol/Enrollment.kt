package com.calllogcontrol

import org.json.JSONObject
import java.io.IOException
import java.util.UUID

data class Enrollment(val endpoint: String, val ca: String, val code: String) {
    fun claim(): JSONObject {
        val connection = ServerTls.open(endpoint, "/v1/enrollments/claim", ca)
        try {
            connection.connectTimeout = 10_000
            connection.readTimeout = 15_000
            connection.requestMethod = "POST"
            connection.setRequestProperty("Authorization", "Bearer $code")
            connection.setRequestProperty("Content-Type", "application/json")
            connection.doOutput = true
            connection.setFixedLengthStreamingMode(2)
            connection.outputStream.use { it.write("{}".toByteArray()) }
            if (connection.responseCode == 401) throw IOException("QR vencido o utilizado. Genera otro en el panel.")
            if (connection.responseCode != 200) throw IOException("El servidor no pudo completar el alta. Genera otro QR.")
            val buffer = ByteArray(4097)
            var length = 0
            connection.inputStream.use { input ->
                while (length < buffer.size) {
                    val count = input.read(buffer, length, buffer.size - length)
                    if (count < 0) break
                    length += count
                }
            }
            require(length <= 4096)
            val data = JSONObject(String(buffer, 0, length, Charsets.UTF_8))
            require(data.getString("token").matches(Regex("[A-Za-z0-9_-]{43}")))
            require(data.getString("name").length in 1..120)
            UUID.fromString(data.getString("device_id"))
            return data
        } finally { connection.disconnect() }
    }

    companion object {
        fun parse(value: String): Enrollment {
            require(value.length in 1..4096) { "QR inválido" }
            val data = JSONObject(value)
            require(data.keys().asSequence().toSet() == setOf("v", "url", "ca", "code") && data.getInt("v") == 1) { "QR no compatible" }
            val endpoint = ServerAddress.normalize(data.getString("url"))
            val ca = data.getString("ca")
            ServerTls.certificate(ca)
            val code = data.getString("code")
            require(code.matches(Regex("[A-Za-z0-9_-]{43}"))) { "Código de alta inválido" }
            return Enrollment(endpoint, ca, code)
        }
    }
}
