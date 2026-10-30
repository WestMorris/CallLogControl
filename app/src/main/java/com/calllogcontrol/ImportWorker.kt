package com.calllogcontrol

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

class ImportWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        try {
            CallImporter.import(applicationContext)
            if (SecurityStore(applicationContext).endpoint.isNotEmpty()) BackgroundWork.sync(applicationContext)
            Result.success()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            applicationContext.getSharedPreferences("status", Context.MODE_PRIVATE).edit()
                .putString("import_error", "No se pudo leer el historial. Revisa los permisos.").apply()
            if (runAttemptCount < 3 && error !is SecurityException) Result.retry() else Result.failure()
        }
    }
}
