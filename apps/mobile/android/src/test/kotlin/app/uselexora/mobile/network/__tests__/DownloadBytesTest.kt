package app.uselexora.mobile.network

import app.uselexora.mobile.protocol.ProtocolFailure
import okhttp3.CertificatePinner
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.io.ByteArrayOutputStream

class DownloadBytesTest {
    private val hash = "a".repeat(64)
    @Test fun largeRangeUsesLongOffsetsAndChecksExactPinnedResponseBeforeWriting() {
        val cert = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        MockWebServer().use { server ->
            server.useHttps(HandshakeCertificates.Builder().heldCertificate(cert).build().sslSocketFactory(), false); server.start()
            val transport = PinnedTransport(server.url("/").toString().trimEnd('/'), CertificatePinner.pin(cert.certificate))
            val start = 4L * 1024 * 1024 * 1024
            val spec = DownloadSpec("res", hash, start + 3, "large.iso", "application/octet-stream")
            val range = "bytes $start-${start + 2}/${start + 3}"
            fun response() = MockResponse().setResponseCode(206).setHeader("ETag", "\"$hash\"").setHeader("Content-Range", range).setBody("end")
            val out = ByteArrayOutputStream()
            fun fetch() = DownloadBytes.fetch(transport, "fixture", "d", spec, start, out, ByteArray(2)) {}
            try {
                server.enqueue(response()); fetch(); assertEquals("end", out.toString("UTF-8"))
                val request = server.takeRequest(); assertEquals("bytes=$start-${start + 2}", request.getHeader("Range")); assertEquals("Bearer fixture", request.getHeader("Authorization")); assertEquals("\"$hash\"", request.getHeader("If-Match"))
                for (wrong in listOf(response().setResponseCode(200), response().setHeader("ETag", "other"), response().setHeader("Content-Range", "bytes 0-2/3"), response().setBody("wrong size"))) {
                    out.reset(); server.enqueue(wrong); assertThrows(ProtocolFailure::class.java) { fetch() }; assertEquals(0, out.size())
                }
                assertEquals(1L, DownloadBytes.length(Long.MAX_VALUE - 1, Long.MAX_VALUE))
            } finally { transport.close() }
        }
    }
    @Test fun digestRejectsTruncatedTrailingAndChangedBytesAndResumeRefusesChangedIdentity() {
        val bytes = "verified output".toByteArray(); val hash = MobileFiles.hash(bytes)
        fun valid(raw: ByteArray) = DownloadBytes.verify(raw.inputStream(), bytes.size.toLong(), hash) {}
        assertTrue(valid(bytes)); assertFalse(valid(bytes + 0)); assertFalse(valid(bytes.dropLast(1).toByteArray())); assertFalse(valid(ByteArray(bytes.size)))
        val record = DownloadRecord("id", "partition", "resource", "rev", "a", "text/plain", DownloadState.PAUSED, 5, bytes.size.toLong(), hash, null, null)
        val spec = DownloadSpec("resource", hash, bytes.size.toLong(), "a", "text/plain")
        assertEquals(record, spec.bind(record)); for (wrong in listOf(spec.copy(resource = "other"), spec.copy(version = "0".repeat(64)), spec.copy(size = spec.size - 1))) {
            assertThrows(ProtocolFailure::class.java) { wrong.bind(record) }
        }
    }
}
