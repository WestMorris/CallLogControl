package com.calllogcontrol

import org.junit.Assert.*
import org.junit.Test
import java.security.MessageDigest

class CoreTest {
    @Test fun httpsOriginValidation() {
        assertEquals("https://example.com:8443", ServerAddress.normalize(" https://example.com:8443/ "))
        listOf("http://example.com", "https://user:secret@example.com", "https://example.com/api",
            "https://example.com?token=x", "https://example.com#x", "https://example.com:99999", "https:///missing")
            .forEach { value -> assertThrows(Exception::class.java) { ServerAddress.normalize(value) } }
    }

    @Test fun csvEscapesQuotesNewlinesAndFormulas() {
        assertEquals("\"'+595991\"", CsvExporter.cell("+595991"))
        assertEquals("\"' \t=1+1\"", CsvExporter.cell(" \t=1+1"))
        assertEquals("\"a\"\"b\nc\"", CsvExporter.cell("a\"b\nc"))
        assertEquals("\"123\"", CsvExporter.cell("123"))
        assertEquals("\"\"", CsvExporter.cell(""))
    }

    @Test fun passwordHashIsSaltedAndReproducible() {
        val salt = ByteArray(16) { it.toByte() }
        val hash = PasswordHash.derive("example password".toCharArray(), salt)
        assertEquals(32, hash.size)
        assertEquals("e07cec5e9869b430d1424d067b943ec4ec6cce916aa8e744222da33f25e424aa",
            hash.joinToString("") { "%02x".format(it) })
        assertTrue(MessageDigest.isEqual(hash, PasswordHash.derive("example password".toCharArray(), salt)))
        assertFalse(MessageDigest.isEqual(hash, PasswordHash.derive("another password".toCharArray(), salt)))
        assertFalse(MessageDigest.isEqual(hash, PasswordHash.derive("example password".toCharArray(), ByteArray(16))))
    }
}
