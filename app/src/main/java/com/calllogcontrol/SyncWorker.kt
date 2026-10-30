package com.calllogcontrol

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.ListenableWorker.Result
import androidx.work.WorkerParameters
import com.calllogcontrol.Database.CallDatabase
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URL
import javax.net.ssl.HttpsURLConnection

class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork() = SyncClient.sync(applicationContext, runAttemptCount)
}

object SyncClient {
    val mutex = Mutex()

    fun poll(endpoint: String, token: String, waitSeconds: Int = 0): String? {
        val (code, body) = request(endpoint, token, "/v1/sync-request?wait=$waitSeconds", readTimeout = (waitSeconds + 10) * 1000)
        if (code != 200) throw HttpError(code)
        val data = JSONObject(body)
        return if (data.isNull("request_id")) null else data.getString("request_id")
    }

    suspend fun sync(context: Context, attempt: Int = 0, requestedId: String? = null): Result = withContext(Dispatchers.IO) {
        mutex.withLock {
            val status = context.getSharedPreferences("status", Context.MODE_PRIVATE)
            try {
                val security = SecurityStore(context)
                val (endpoint, token) = security.credentials() ?: return@withLock Result.success()
                val requestId = requestedId ?: poll(endpoint, token)
                if (requestId != null) {
                    if (!security.consented || !CallImporter.permitted(context)) throw SecurityException()
                    CallImporter.import(context)
                }
                val dao = CallDatabase.get(context).calls()
                repeat(5) {
                    val batch = dao.pending()
                    if (batch.isEmpty()) {
                        if (requestId != null) {
                            val code = request(endpoint, token, "/v1/sync-ack", JSONObject().put("request_id", requestId)).first
                            if (code != 204) throw HttpError(code)
                        }
                        status.edit().putLong("last_sync", System.currentTimeMillis()).putString("sync_error", "").apply()
                        return@withLock Result.success()
                    }
                    val calls = JSONArray()
                    batch.forEach { call ->
                        calls.put(JSONObject().put("id", call.id).put("number", call.number).put("type", call.type)
                            .put("started_at", call.startedAt).put("duration_seconds", call.durationSeconds)
                            .put("presentation", call.presentation))
                    }
                    val code = request(endpoint, token, "/v1/calls", JSONObject().put("calls", calls)).first
                    if (code != 204) throw HttpError(code)
                    dao.acknowledge(batch)
                    status.edit().putLong("last_sync", System.currentTimeMillis()).putString("sync_error", "").apply()
                }
                // shortcut: upload 500 calls per execution, drain larger histories in later work runs.
                Result.retry()
            } catch (error: CancellationException) { throw error }
            catch (_: SecurityException) {
                status.edit().putString("sync_error", "La solicitud remota requiere autorizar el acceso al historial.").apply()
                Result.failure()
            } catch (error: HttpError) {
                status.edit().putString("sync_error", if (error.code == 401 || error.code == 403)
                    "Credencial inválida o equipo revocado. Revisa la configuración." else "El servidor respondió HTTP ${error.code}. Los registros siguen en este equipo.").apply()
                if ((error.code == 429 || error.code >= 500) && attempt < 5) Result.retry() else Result.failure()
            } catch (_: IOException) {
                status.edit().putString("sync_error", "Sin conexión segura con el servidor. Se reintentará automáticamente.").apply()
                if (attempt < 5) Result.retry() else Result.failure()
            } catch (_: Exception) {
                status.edit().putString("sync_error", "No se pudo sincronizar. Revisa la URL HTTPS y vuelve a guardar la credencial.").apply()
                Result.failure()
            }
        }
    }

    private fun request(endpoint: String, token: String, path: String, payload: JSONObject? = null, readTimeout: Int = 20_000): Pair<Int, String> {
        val connection = URL(ServerAddress.normalize(endpoint) + path).openConnection() as HttpsURLConnection
        try {
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 10_000
            connection.readTimeout = readTimeout
            connection.setRequestProperty("Authorization", "Bearer $token")
            if (payload != null) {
                val body = payload.toString().toByteArray(Charsets.UTF_8)
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                connection.setFixedLengthStreamingMode(body.size)
                connection.outputStream.use { it.write(body) }
            }
            val code = connection.responseCode
            val body = if (code == 200) connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() } else ""
            return code to body
        } finally { connection.disconnect() }
    }

    private class HttpError(val code: Int) : IOException("HTTP $code")
}
