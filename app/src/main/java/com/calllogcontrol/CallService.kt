package com.calllogcontrol

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class CallService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var job: Job? = null

    override fun onCreate() {
        super.onCreate()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel("imports", "Importación del historial", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        startForeground(1, Notification.Builder(this, "imports").setSmallIcon(com.calllogcontrol.R.drawable.ic_phone)
            .setContentTitle("CallLog Control").setContentText("Guardando registros en este equipo…")
            .setContentIntent(open).setOngoing(true).build())
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (job?.isActive != true) job = scope.launch {
            try {
                CallImporter.import(this@CallService)
                BackgroundWork.sync(this@CallService)
            } catch (error: CancellationException) {
                throw error
            } catch (_: Exception) {
                getSharedPreferences("status", MODE_PRIVATE).edit()
                    .putString("import_error", "No se pudo importar. Revisa los permisos e intenta de nuevo.").apply()
            } finally {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    override fun onTimeout(startId: Int, fgsType: Int) { scope.cancel(); stopSelf() }
    override fun onDestroy() { scope.cancel(); super.onDestroy() }
    override fun onBind(intent: Intent?): IBinder? = null
}
