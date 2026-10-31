package com.calllogcontrol

import android.Manifest
import android.app.AlertDialog
import android.content.Intent
import android.content.SharedPreferences
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.text.InputType
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.EditText
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import androidx.room.withTransaction
import com.calllogcontrol.Database.CallDatabase
import com.calllogcontrol.Database.CallRecord
import com.calllogcontrol.databinding.ActivityMainBinding
import com.calllogcontrol.databinding.RowCallBinding
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

class MainActivity : ComponentActivity() {
    private lateinit var binding: ActivityMainBinding
    private lateinit var security: SecurityStore
    private var authenticated = false
    private var epoch = 0
    private var pendingExport: Uri? = null
    private var pendingEnrollment: String? = null
    private var dialog: AlertDialog? = null
    private var dashboardJob: Job? = null
    private val adapter = CallsAdapter()
    private val statusListener = SharedPreferences.OnSharedPreferenceChangeListener { _, _ ->
        runOnUiThread { if (authenticated) refreshStatus() }
    }
    private val dao by lazy { CallDatabase.get(this).calls() }
    private val scanQr = registerForActivityResult(ScanContract()) { result ->
        result.contents?.let { value ->
            pendingEnrollment = value
            if (authenticated) reviewEnrollment()
            else binding.loginError.text = "Desbloquea para confirmar el alta por QR."
        }
    }
    private val permissionRequest = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        if (CallImporter.permitted(this)) {
            BackgroundWork.schedule(this)
            BackgroundWork.collect(this)
        } else toast("Sin permiso no se puede importar. Puedes concederlo desde los ajustes de Android.")
        if (authenticated) refreshStatus()
    }
    private val createCsv = registerForActivityResult(ActivityResultContracts.CreateDocument("text/csv")) { uri ->
        if (uri != null) {
            pendingExport = uri
            if (authenticated) export(uri) else binding.loginError.text = "Desbloquea para guardar el CSV en el destino elegido."
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        security = SecurityStore(this)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            insets
        }
        binding.calls.layoutManager = LinearLayoutManager(this)
        binding.calls.adapter = adapter
        binding.unlock.setOnClickListener { unlock() }
        binding.lock.setOnClickListener { lock() }
        binding.permissions.setOnClickListener { explainCollection() }
        binding.importCalls.setOnClickListener {
            if (!security.consented || !CallImporter.permitted(this)) explainCollection()
            else try {
                startForegroundService(Intent(this, CallService::class.java))
                toast("Importando historial…")
            } catch (_: RuntimeException) {
                BackgroundWork.collect(this)
                toast("Importación programada en segundo plano")
            }
        }
        binding.exportCsv.setOnClickListener {
            createCsv.launch("llamadas-${java.time.LocalDate.now()}.csv")
        }
        binding.settings.setOnClickListener { serverSettings() }
        binding.enroll.setOnClickListener {
            scanQr.launch(ScanOptions().setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setCaptureActivity(QrScanActivity::class.java).setOrientationLocked(false)
                .setBeepEnabled(false).setPrompt("Escanea el QR de alta del panel de tu empresa"))
        }
        binding.sync.setOnClickListener {
            if (security.endpoint.isEmpty()) serverSettings()
            else { BackgroundWork.sync(this); toast("Sincronización programada; requiere conexión") }
        }
        binding.remoteSync.setOnClickListener {
            if (RemoteSyncService.running) { stopService(Intent(this, RemoteSyncService::class.java)); return@setOnClickListener }
            if (!security.consented || !CallImporter.permitted(this)) { explainCollection(); return@setOnClickListener }
            if (security.endpoint.isEmpty()) { serverSettings(); return@setOnClickListener }
            if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                permissionRequest.launch(arrayOf(Manifest.permission.POST_NOTIFICATIONS))
                toast("Autoriza las notificaciones y vuelve a activar el control remoto")
                return@setOnClickListener
            }
            dialog = AlertDialog.Builder(this).setTitle("Control remoto por Wi-Fi")
                .setMessage("Mantiene una conexión con el servidor para responder en segundos incluso con la pantalla apagada. Muestra una notificación permanente y consume más batería. Permite el uso sin restricciones de batería cuando Android lo solicite. Puedes detenerlo aquí o desde la notificación.")
                .setNegativeButton("Cancelar", null).setPositiveButton("Activar") { _, _ ->
                    startForegroundService(Intent(this, RemoteSyncService::class.java))
                    if (!getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)) {
                        startActivity(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName")))
                    }
                }.show()
        }
        getSharedPreferences("status", MODE_PRIVATE).registerOnSharedPreferenceChangeListener(statusListener)
        lock()
    }

    private fun unlock() {
        if (security.cooldownSeconds > 0) {
            binding.loginError.text = "Espera ${security.cooldownSeconds} segundos antes de volver a intentar."
            return
        }
        val password = binding.password.text.toString().toCharArray()
        val setup = !security.hasPassword
        if (setup && (password.size !in 8..256 || !password.contentEquals(binding.confirmation.text.toString().toCharArray()))) {
            password.fill('\u0000')
            binding.loginError.text = "Usa al menos 8 caracteres y repite la misma contraseña."
            return
        }
        val requestEpoch = epoch
        binding.unlock.isEnabled = false
        binding.loginError.text = "Verificando…"
        lifecycleScope.launch {
            try {
                val valid = withContext(Dispatchers.IO) {
                    if (setup) { security.createPassword(password); true } else security.verify(password)
                }
                if (requestEpoch != epoch || !lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)) return@launch
                if (valid) {
                    authenticated = true
                    binding.password.text.clear()
                    binding.confirmation.text.clear()
                    binding.loginPanel.isVisible = false
                    binding.dashboard.isVisible = true
                    refreshStatus()
                    dashboardJob = lifecycleScope.launch {
                        launch { dao.latest().collect { adapter.submitList(it); binding.empty.isVisible = it.isEmpty() } }
                        launch { dao.stats().collect {
                            binding.total.text = resources.getQuantityString(R.plurals.record_count, it.total, it.total)
                            binding.pending.text = resources.getQuantityString(R.plurals.pending_count, it.pending, it.pending)
                        } }
                    }
                    if (security.consented && CallImporter.permitted(this@MainActivity)) BackgroundWork.collect(this@MainActivity)
                    pendingExport?.let { export(it) }
                    if (pendingEnrollment != null) reviewEnrollment()
                } else binding.loginError.text = "Contraseña incorrecta."
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) { binding.loginError.text = "No se pudo verificar el acceso. Intenta de nuevo." }
            finally { password.fill('\u0000'); binding.unlock.isEnabled = true }
        }
    }

    private fun lock() {
        epoch++
        authenticated = false
        dashboardJob?.cancel()
        dialog?.dismiss()
        dialog = null
        adapter.submitList(emptyList())
        binding.dashboard.isVisible = false
        binding.loginPanel.isVisible = true
        binding.password.text.clear()
        binding.confirmation.text.clear()
        binding.loginError.text = when {
            pendingEnrollment != null -> "Desbloquea para confirmar el alta por QR."
            pendingExport != null -> "Desbloquea para guardar el CSV en el destino elegido."
            else -> ""
        }
        binding.confirmation.isVisible = !security.hasPassword
        binding.loginTitle.text = if (security.hasPassword) "Acceso protegido" else "Protege este equipo"
        binding.loginDescription.text = if (security.hasPassword) "Introduce tu contraseña para consultar y exportar los registros."
            else "Crea una contraseña de al menos 8 caracteres. Guárdala: no hay recuperación de contraseña."
        binding.unlock.text = if (security.hasPassword) "Desbloquear" else "Crear contraseña"
    }

    private fun explainCollection() {
        dialog = AlertDialog.Builder(this).setTitle("Acceso al historial")
            .setMessage("Se importarán las llamadas existentes y futuras: número, fecha, tipo y duración. No se graba audio. Se guardan en este equipo; solo se envían al configurar tu servidor. La captura autorizada continúa con la app bloqueada. Puedes detenerla revocando el permiso en Android.")
            .setNegativeButton("Cancelar", null).setPositiveButton("Autorizar") { _, _ ->
                security.acceptCollection()
                val permissions = mutableListOf(Manifest.permission.READ_CALL_LOG, Manifest.permission.READ_PHONE_STATE)
                if (Build.VERSION.SDK_INT >= 33) permissions.add(Manifest.permission.POST_NOTIFICATIONS)
                permissionRequest.launch(permissions.toTypedArray())
            }.setNeutralButton("Ajustes de Android") { _, _ ->
                startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
            }.show()
    }

    private fun refreshStatus() {
        val prefs = getSharedPreferences("status", MODE_PRIVATE)
        val permitted = security.consented && CallImporter.permitted(this)
        binding.permissions.isVisible = !permitted
        binding.remoteSync.text = if (RemoteSyncService.running) "Detener control remoto" else "Activar control remoto"
        val imported = prefs.getLong("last_import", 0)
        val synced = prefs.getLong("last_sync", 0)
        val lines = mutableListOf(if (permitted) "Captura autorizada · actualización en segundo plano" else "Sin acceso al historial")
        if (imported > 0) lines.add("Última lectura: ${dateTime(imported)}")
        if (security.endpoint.isEmpty()) lines.add("Servidor sin configurar · almacenamiento local")
        else lines.add(if (synced > 0) "Último envío: ${dateTime(synced)}" else "Servidor configurado · esperando primer envío")
        if (security.deviceName.isNotEmpty()) lines.add("Equipo: ${security.deviceName}")
        if (RemoteSyncService.running) {
            lines.add("Control remoto activo · notificación permanente")
            if (!getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(packageName)) lines.add("Permite batería sin restricciones para responder con pantalla apagada.")
        }
        listOf("import_error", "sync_error").map { prefs.getString(it, "").orEmpty() }.filter { it.isNotEmpty() }.forEach(lines::add)
        binding.status.text = lines.joinToString("\n")
    }

    private fun reviewEnrollment() {
        val value = pendingEnrollment ?: return
        pendingEnrollment = null
        val enrollment = try { Enrollment.parse(value) } catch (_: Exception) {
            toast("QR no válido. Genera uno nuevo desde el panel de tu empresa."); return
        }
        dialog = AlertDialog.Builder(this).setTitle("Vincular con tu servidor")
            .setMessage("Servidor: ${enrollment.endpoint}\nHuella: ${ServerTls.fingerprint(enrollment.ca).take(16)}\n\nConfirma que el código procede del panel de tu empresa. Al vincular se enviará todo el historial local por HTTPS. La confianza en este certificado se limita a este servidor dentro de la app.")
            .setNegativeButton("Cancelar", null).setPositiveButton("Vincular y sincronizar") { _, _ ->
                binding.enroll.isEnabled = false
                lifecycleScope.launch {
                    try {
                        withContext(Dispatchers.IO) { SyncClient.mutex.withLock {
                            val device = enrollment.claim()
                            dao.resetSync()
                            security.saveCredentials(enrollment.endpoint, device.getString("token"), enrollment.ca, device.getString("name"))
                            getSharedPreferences("status", MODE_PRIVATE).edit().remove("sync_error").remove("last_sync").apply()
                        } }
                        BackgroundWork.schedule(this@MainActivity)
                        BackgroundWork.sync(this@MainActivity)
                        toast("Equipo vinculado. Autoriza el historial si aún no lo has hecho.")
                        if (authenticated) refreshStatus()
                    } catch (error: CancellationException) { throw error }
                    catch (_: Exception) { toast("No se pudo vincular. Comprueba la Wi-Fi, la hora y el servidor; si el QR venció o se usó, genera otro.") }
                    finally { binding.enroll.isEnabled = true }
                }
            }.show().also { it.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE) }
    }

    private fun serverSettings() {
        val form = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(24, 8, 24, 0)
        }
        val url = EditText(this).apply { hint = "https://llamadas.empresa.com"; setText(security.endpoint); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI; maxLines = 1 }
        val token = EditText(this).apply { hint = "Credencial del equipo"; inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD; maxLines = 1; importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO }
        val keepCertificate = CheckBox(this).apply { text = "Conservar certificado actual al cambiar la IP"; isVisible = security.serverCa != null }
        form.addView(url)
        form.addView(token)
        form.addView(keepCertificate)
        val currentEpoch = epoch
        dialog = AlertDialog.Builder(this).setTitle("Servidor de la empresa")
            .setMessage("Al guardar se enviará todo el historial local por HTTPS. Usa la credencial propia de este equipo, nunca la de administrador. Deja la credencial vacía para conservar la actual. Cambiar el destino vuelve a enviar todos los registros.")
            .setView(form).setNegativeButton("Cancelar", null).setPositiveButton("Guardar y activar", null)
            .setNeutralButton("Desactivar", null).create().also { alert ->
                alert.setOnShowListener {
                    alert.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener {
                        val address = try { ServerAddress.normalize(url.text.toString()) } catch (_: Exception) { url.error = "Usa una URL HTTPS válida sin ruta"; return@setOnClickListener }
                        alert.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = false
                        val enteredToken = token.text.toString().trim()
                        lifecycleScope.launch {
                            try {
                                withContext(Dispatchers.IO) { SyncClient.mutex.withLock {
                                    val credential = enteredToken.ifEmpty { security.credentials()?.second.orEmpty() }
                                    require(security.validToken(credential))
                                    // Reset before saving: an interrupted change must never skip uploading old rows.
                                    dao.resetSync()
                                    security.saveCredentials(address, credential,
                                        if (keepCertificate.isChecked) security.serverCa else null,
                                        if (keepCertificate.isChecked) security.deviceName else null)
                                    getSharedPreferences("status", MODE_PRIVATE).edit().remove("sync_error").remove("last_sync").apply()
                                } }
                                BackgroundWork.schedule(this@MainActivity)
                                BackgroundWork.sync(this@MainActivity)
                                alert.dismiss()
                                if (authenticated) refreshStatus()
                            } catch (error: CancellationException) { throw error }
                            catch (_: Exception) { if (authenticated && currentEpoch == epoch) token.error = "Revisa la credencial (mínimo ${security.minimumTokenLength} caracteres)" }
                            finally { alert.getButton(AlertDialog.BUTTON_POSITIVE).isEnabled = true; token.text.clear() }
                        }
                    }
                    alert.getButton(AlertDialog.BUTTON_NEUTRAL).setOnClickListener {
                        lifecycleScope.launch {
                            withContext(Dispatchers.IO) { SyncClient.mutex.withLock { security.disableSync() } }
                            stopService(Intent(this@MainActivity, RemoteSyncService::class.java))
                            alert.dismiss()
                            if (authenticated) refreshStatus()
                        }
                    }
                }
                alert.show()
                alert.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
    }

    private fun export(uri: Uri) {
        pendingExport = null
        lifecycleScope.launch {
            try {
                withContext(Dispatchers.IO) {
                    val stream = contentResolver.openOutputStream(uri, "wt") ?: error("Destino no disponible")
                    stream.bufferedWriter(Charsets.UTF_8).use { writer ->
                        CallDatabase.get(this@MainActivity).withTransaction { CsvExporter.write(dao, writer) }
                    }
                }
                toast("CSV guardado")
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) { toast("No se pudo completar el CSV. El archivo puede estar incompleto; vuelve a exportarlo.") }
        }
    }

    override fun onResume() { super.onResume(); if (authenticated) refreshStatus() else lock() }
    override fun onStop() { lock(); super.onStop() }
    override fun onDestroy() {
        getSharedPreferences("status", MODE_PRIVATE).unregisterOnSharedPreferenceChangeListener(statusListener)
        super.onDestroy()
    }
    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()
}

private val dateFormatter = DateTimeFormatter.ofPattern("dd/MM/yyyy HH:mm").withZone(ZoneId.systemDefault())
private fun dateTime(value: Long): String = dateFormatter.format(Instant.ofEpochMilli(value))

private class CallsAdapter : ListAdapter<CallRecord, CallsAdapter.Holder>(object : DiffUtil.ItemCallback<CallRecord>() {
    override fun areItemsTheSame(old: CallRecord, new: CallRecord) = old.id == new.id
    override fun areContentsTheSame(old: CallRecord, new: CallRecord) = old == new
}) {
    class Holder(val binding: RowCallBinding) : RecyclerView.ViewHolder(binding.root)
    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) = Holder(RowCallBinding.inflate(LayoutInflater.from(parent.context), parent, false))
    override fun onBindViewHolder(holder: Holder, position: Int) {
        val call = getItem(position)
        holder.binding.number.text = if (call.presentation == 1 && call.number.isNotBlank()) call.number else "Número privado o desconocido"
        holder.binding.synced.text = if (call.synced) "Enviado" else "Local"
        holder.binding.details.text = "${callType(call.type)} · ${dateTime(call.startedAt)} · ${call.durationSeconds / 60}m ${call.durationSeconds % 60}s"
    }
}
