package com.calllogcontrol

import android.content.Context
import android.content.pm.ApplicationInfo
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec

object PasswordHash {
    fun derive(password: CharArray, salt: ByteArray): ByteArray {
        val spec = PBEKeySpec(password, salt, 210_000, 256)
        return try { SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded }
        finally { spec.clearPassword() }
    }
}

class SecurityStore(context: Context) {
    private val prefs = context.getSharedPreferences("security", Context.MODE_PRIVATE)
    // shortcut: debug accepts short test tokens, use random 32-character tokens before deployment.
    val minimumTokenLength = if (context.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) 10 else 32
    fun validToken(token: String) = token.length in minimumTokenLength..256 && token.none { it.isWhitespace() || it.isISOControl() }
    val hasPassword get() = prefs.contains("password_hash")
    val endpoint get() = prefs.getString("endpoint", "").orEmpty()
    val serverCa get() = prefs.getString("server_ca", null)
    val deviceName get() = prefs.getString("device_name", "").orEmpty()
    val consented get() = prefs.getBoolean("consented", false)
    val cooldownSeconds get() = ((prefs.getLong("blocked_until", 0) - System.currentTimeMillis()) / 1000 + 1).coerceAtLeast(0)

    fun createPassword(password: CharArray) {
        require(password.size in 8..256)
        val salt = ByteArray(16).also { SecureRandom().nextBytes(it) }
        check(prefs.edit().putString("salt", encode(salt))
            .putString("password_hash", encode(PasswordHash.derive(password, salt))).commit())
    }

    fun verify(password: CharArray): Boolean {
        if (cooldownSeconds > 0 || !hasPassword) return false
        val salt = decode(prefs.getString("salt", "").orEmpty())
        val expected = decode(prefs.getString("password_hash", "").orEmpty())
        val valid = MessageDigest.isEqual(expected, PasswordHash.derive(password, salt))
        val attempts = if (valid) 0 else prefs.getInt("attempts", 0) + 1
        check(prefs.edit().putInt("attempts", if (attempts >= 5) 0 else attempts)
            .putLong("blocked_until", if (attempts >= 5) System.currentTimeMillis() + 30_000 else 0).commit())
        return valid
    }

    fun acceptCollection() { check(prefs.edit().putBoolean("consented", true).commit()) }

    fun credentials(): Pair<String, String>? {
        if (endpoint.isEmpty()) return null
        val encrypted = prefs.getString("token", null) ?: return null
        val parts = encrypted.split(":")
        require(parts.size == 2)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, decode(parts[0])))
        return endpoint to String(cipher.doFinal(decode(parts[1])), Charsets.UTF_8)
    }

    fun saveCredentials(url: String, token: String, ca: String? = null, name: String? = null) {
        require(validToken(token))
        val normalized = ServerAddress.normalize(url)
        val selectedCa = ca ?: if (normalized == endpoint) serverCa else null
        if (selectedCa != null) ServerTls.certificate(selectedCa)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val encrypted = encode(cipher.iv) + ":" + encode(cipher.doFinal(token.toByteArray(Charsets.UTF_8)))
        check(prefs.edit().putString("endpoint", normalized).putString("token", encrypted)
            .putString("server_ca", selectedCa).putString("device_name", name ?: if (normalized == endpoint) deviceName else "").commit())
    }

    fun disableSync() { check(prefs.edit().remove("endpoint").remove("token").remove("server_ca").remove("device_name").commit()) }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("calllog_token", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("calllog_token", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }

    private fun encode(value: ByteArray) = Base64.getEncoder().encodeToString(value)
    private fun decode(value: String) = Base64.getDecoder().decode(value)
}
