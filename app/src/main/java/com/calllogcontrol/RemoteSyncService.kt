package com.calllogcontrol

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder
import android.os.PowerManager
import androidx.work.ListenableWorker.Result
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class RemoteSyncService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private lateinit var wakeLock: PowerManager.WakeLock

    override fun onCreate() {
        super.onCreate()
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(NotificationChannel("remote", "Control remoto activo", NotificationManager.IMPORTANCE_LOW))
        val open = PendingIntent.getActivity(this, 10, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = PendingIntent.getService(this, 11, Intent(this, RemoteSyncService::class.java).setAction("STOP"), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        startForeground(2, Notification.Builder(this, "remote").setSmallIcon(R.drawable.ic_phone)
            .setContentTitle("Control remoto activo").setContentText("Esperando solicitudes de sincronización por Wi-Fi")
            .setContentIntent(open).setOngoing(true).addAction(Notification.Action.Builder(null, "Detener", stop).build()).build())
        running = true
        wakeLock = getSystemService(PowerManager::class.java).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "CallLogControl:RemoteSync").apply { setReferenceCounted(false) }
        getSharedPreferences("status", MODE_PRIVATE).edit().putBoolean("remote_active", true).apply()
        scope.launch {
            while (isActive) {
                try {
                    // Keep the local command channel responsive with the screen off; release when the user stops it.
                    wakeLock.acquire(10 * 60 * 1000L)
                    val security = SecurityStore(this@RemoteSyncService)
                    val credentials = security.credentials()
                    if (credentials == null) { stopSelf(); break }
                    val request = SyncClient.poll(credentials.first, credentials.second, waitSeconds = 25, ca = security.serverCa)
                    ensureActive()
                    if (request != null && SecurityStore(this@RemoteSyncService).credentials() == credentials) {
                        val result = SyncClient.sync(this@RemoteSyncService, requestedId = request)
                        if (result != Result.success()) delay(10_000)
                    }
                } catch (error: CancellationException) { throw error }
                catch (_: Exception) {
                    getSharedPreferences("status", MODE_PRIVATE).edit().putString("sync_error", "Control remoto: sin conexión segura. Reintentando…").apply()
                    delay(10_000)
                }
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == "STOP") { stopSelf(); return START_NOT_STICKY }
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        scope.cancel()
        if (::wakeLock.isInitialized && wakeLock.isHeld) wakeLock.release()
        getSharedPreferences("status", MODE_PRIVATE).edit().putBoolean("remote_active", false).apply()
        stopForeground(STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
    override fun onBind(intent: Intent?): IBinder? = null

    companion object { @Volatile var running = false; private set }
}
