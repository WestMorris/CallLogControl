package com.calllogcontrol

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.calllogcontrol.Database.CallDatabase
import com.calllogcontrol.Database.CallRecord
import com.google.zxing.BinaryBitmap
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.security.cert.CertificateFactory
import java.util.Base64
import java.util.UUID
import javax.net.ssl.SSLException

@RunWith(AndroidJUnit4::class)
class EnrollmentTest {
    private fun testCa(): String {
        val context = InstrumentationRegistry.getInstrumentation().context
        return context.assets.open("enrollment-ca.crt").use {
            Base64.getEncoder().encodeToString(CertificateFactory.getInstance("X.509").generateCertificate(it).encoded)
        }
    }

    @Test fun rejectsUntrustedQrInputAndScopesStoredCertificateToItsEndpoint() {
        val valid = JSONObject().put("v", 1).put("url", "https://192.168.1.100:8443")
            .put("ca", testCa()).put("code", "x".repeat(43))
        assertEquals("https://192.168.1.100:8443", Enrollment.parse(valid.toString()).endpoint)
        for (invalid in listOf(
            JSONObject(valid.toString()).put("url", "http://192.168.1.100"),
            JSONObject(valid.toString()).put("url", "https://user:password@192.168.1.100"),
            JSONObject(valid.toString()).put("code", "weak"),
            JSONObject(valid.toString()).put("ca", "not-a-certificate"),
            JSONObject(valid.toString()).put("v", 2),
            JSONObject(valid.toString()).put("unexpected", true)
        )) assertThrows(Exception::class.java) { Enrollment.parse(invalid.toString()) }
        assertThrows(Exception::class.java) { Enrollment.parse("x".repeat(4097)) }
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val security = SecurityStore(context)
        try {
            security.saveCredentials("https://192.168.1.100:8443", "x".repeat(43), testCa(), "Ventas QR")
            assertEquals(testCa(), security.serverCa)
            assertEquals("Ventas QR", security.deviceName)
            security.saveCredentials(security.endpoint, "y".repeat(43))
            assertEquals(testCa(), security.serverCa)
            security.saveCredentials("https://192.168.1.101:8443", "y".repeat(43), security.serverCa, security.deviceName)
            assertEquals(testCa(), security.serverCa)
            assertEquals("Ventas QR", security.deviceName)
            security.saveCredentials("https://another.example", "z".repeat(43))
            assertNull(security.serverCa)
            assertEquals("", security.deviceName)
        } finally { security.disableSync() }
    }

    @Test fun decodesServerQrClaimsOverPinnedTlsAndSynchronizes() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        val matrix = args.getString("enrollmentMatrix")
        assumeTrue("Provide a real server QR matrix for this live integration test", matrix != null)
        val bits = requireNotNull(matrix)
        val size = kotlin.math.sqrt(bits.length.toDouble()).toInt()
        assertEquals(size * size, bits.length)
        val width = size * 4
        val pixels = IntArray(width * width) { index ->
            if (bits[(index / width / 4) * size + index % width / 4] == '1') 0xFF000000.toInt() else 0xFFFFFFFF.toInt()
        }
        val decoded = QRCodeReader().decode(BinaryBitmap(HybridBinarizer(RGBLuminanceSource(width, width, pixels)))).text
        val enrollment = Enrollment.parse(decoded)
        val security = SecurityStore(InstrumentationRegistry.getInstrumentation().targetContext)
        val dao = CallDatabase.get(InstrumentationRegistry.getInstrumentation().targetContext).calls()
        val id = "qr-test-${UUID.randomUUID()}"
        try {
            val wrongCa = ServerTls.open(enrollment.endpoint, "/healthz", testCa())
            wrongCa.connectTimeout = 5000; wrongCa.readTimeout = 5000
            try { assertThrows(SSLException::class.java) { wrongCa.responseCode } } finally { wrongCa.disconnect() }
            val wrongHost = ServerTls.open(enrollment.endpoint.replace(java.net.URI(enrollment.endpoint).host, "10.0.2.2"), "/healthz", enrollment.ca)
            wrongHost.connectTimeout = 5000; wrongHost.readTimeout = 5000
            try { assertThrows(SSLException::class.java) { wrongHost.responseCode } } finally { wrongHost.disconnect() }
            val device = enrollment.claim()
            security.saveCredentials(enrollment.endpoint, device.getString("token"), enrollment.ca, device.getString("name"))
            assertThrows(java.io.IOException::class.java) { enrollment.claim() }
            dao.put(CallRecord(id, "+595990000001", 2, System.currentTimeMillis(), 10, 1))
            assertEquals(androidx.work.ListenableWorker.Result.success(), SyncClient.sync(InstrumentationRegistry.getInstrumentation().targetContext))
            assertTrue(dao.find(id)?.synced == true)
        } finally {
            security.disableSync()
            CallDatabase.get(InstrumentationRegistry.getInstrumentation().targetContext).openHelper.writableDatabase
                .execSQL("DELETE FROM calls WHERE id=?", arrayOf(id))
        }
    }
}
