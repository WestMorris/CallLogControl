package com.calllogcontrol

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CallLog
import com.calllogcontrol.Database.CallDatabase
import com.calllogcontrol.Database.CallRecord
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

object CallImporter {
    private val mutex = Mutex()

    fun permitted(context: Context) = context.checkSelfPermission(Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED

    suspend fun import(context: Context) = mutex.withLock {
        if (!SecurityStore(context).consented || !permitted(context)) return@withLock
        val dao = CallDatabase.get(context).calls()
        val fields = arrayOf(CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.TYPE,
            CallLog.Calls.DATE, CallLog.Calls.DURATION, CallLog.Calls.NUMBER_PRESENTATION)
        val cursor = context.contentResolver.query(CallLog.Calls.CONTENT_URI, fields, null, null, "${CallLog.Calls.DATE} ASC")
            ?: throw java.io.IOException("Historial no disponible")
        cursor.use {
            val batch = ArrayList<CallRecord>(200)
            while (it.moveToNext()) {
                val started = it.getLong(3)
                batch.add(CallRecord("${it.getLong(0)}-$started", it.getString(1).orEmpty(),
                    it.getInt(2), started, it.getLong(4).coerceAtLeast(0), it.getInt(5)))
                if (batch.size == 200) { dao.merge(batch); batch.clear() }
            }
            if (batch.isNotEmpty()) dao.merge(batch)
        }
        context.getSharedPreferences("status", Context.MODE_PRIVATE).edit()
            .putLong("last_import", System.currentTimeMillis()).putString("import_error", "").apply()
    }
}
