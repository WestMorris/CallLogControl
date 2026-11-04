package com.calllogcontrol

import com.calllogcontrol.Database.CallDao
import com.calllogcontrol.Database.CallRecord
import java.io.Writer
import java.time.Instant

object CsvExporter {
    fun cell(value: String): String {
        val safe = if (value.trimStart(' ', '\t', '\r', '\n').firstOrNull() in listOf('=', '+', '-', '@')) "'$value" else value
        return "\"${safe.replace("\"", "\"\"")}\""
    }

    suspend fun write(dao: CallDao, writer: Writer) {
        writer.write("\uFEFFid,numero,tipo,inicio_utc,duracion_segundos,presentacion,sincronizada,sim_o_linea,cuenta_telefonica_id,cuenta_telefonica_componente\r\n")
        var after = 0L
        while (true) {
            val page = dao.exportPage(after)
            if (page.isEmpty()) break
            page.forEach { row ->
                val call = row.record
                writer.write(listOf(call.id, call.number, callType(call.type), Instant.ofEpochMilli(call.startedAt).toString(),
                    call.durationSeconds.toString(), call.presentation.toString(), if (call.synced) "Sí" else "No",
                    callLine(call), call.phoneAccountId, call.phoneAccountComponentName)
                    .joinToString(",", transform = ::cell) + "\r\n")
            }
            after = page.last().rowId
        }
    }
}

fun callLine(call: CallRecord) = when {
    call.lineLabel.isNotEmpty() && call.phoneAccountId.isNotEmpty() -> "${call.lineLabel} (${call.phoneAccountId})"
    call.lineLabel.isNotEmpty() -> call.lineLabel
    call.phoneAccountId.isNotEmpty() -> call.phoneAccountId
    else -> "No disponible"
}

fun callType(type: Int) = when (type) {
    1 -> "Entrante"
    2 -> "Saliente"
    3 -> "Perdida"
    4 -> "Buzón de voz"
    5 -> "Rechazada"
    6 -> "Bloqueada"
    7 -> "Contestada en otro equipo"
    else -> "Otra"
}
