package com.calllogcontrol

import java.net.URL
import java.security.KeyStore
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Base64
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory

object ServerTls {
    fun certificate(encoded: String): X509Certificate {
        require(encoded.length <= 2400) { "Certificado demasiado grande" }
        val bytes = Base64.getDecoder().decode(encoded)
        val cert = CertificateFactory.getInstance("X.509").generateCertificate(bytes.inputStream()) as X509Certificate
        require(cert.basicConstraints >= 0 && cert.subjectX500Principal == cert.issuerX500Principal) { "Se requiere una autoridad raíz" }
        cert.checkValidity()
        cert.verify(cert.publicKey)
        return cert
    }

    fun fingerprint(encoded: String) = MessageDigest.getInstance("SHA-256").digest(certificate(encoded).encoded)
        .joinToString("") { "%02x".format(it) }

    fun open(endpoint: String, path: String, ca: String? = null): HttpsURLConnection {
        val connection = URL(ServerAddress.normalize(endpoint) + path).openConnection() as HttpsURLConnection
        if (ca != null) {
            val store = KeyStore.getInstance(KeyStore.getDefaultType()).apply { load(null); setCertificateEntry("server", certificate(ca)) }
            val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(store) }
            connection.sslSocketFactory = SSLContext.getInstance("TLS").apply { init(null, trust.trustManagers, null) }.socketFactory
        }
        // Keep Android's hostname verification; QR trust applies only to this connection.
        connection.instanceFollowRedirects = false
        return connection
    }
}
