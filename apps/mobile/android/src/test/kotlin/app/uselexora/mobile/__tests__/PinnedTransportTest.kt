package app.uselexora.mobile

import app.uselexora.mobile.network.PinnedTransport
import okhttp3.CertificatePinner
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

class PinnedTransportTest {
    private fun server(certificate: HeldCertificate): MockWebServer = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
        start()
    }
    @Test fun onePinnedIdentityProtectsPairingUploadRangeAndWebSocket() {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        server(certificate).use { host ->
            val client = PinnedTransport(host.url("/").toString().trimEnd('/'), CertificatePinner.pin(certificate.certificate))
            host.enqueue(MockResponse().setBody("{}"))
            client.json("/v1/pairing/confirm", org.json.JSONObject(), "fixture-credential")
            assertEquals("Bearer fixture-credential", host.takeRequest().getHeader("Authorization"))
            host.enqueue(MockResponse().setBody("{}"))
            client.request("/v1/uploads/id/chunks?offset=0", "PUT", byteArrayOf(1,2,3), "fixture-credential", mapOf("Content-Type" to "application/octet-stream")).close()
            assertEquals("PUT", host.takeRequest().method)
            host.enqueue(MockResponse().setResponseCode(206).setHeader("ETag", "\"fixed\"").setBody("bytes"))
            client.request("/v1/resources/id", credential = "fixture-credential", headers = mapOf("Range" to "bytes=0-4", "If-Match" to "\"fixed\"")).use { assertEquals(206, it.code) }
            assertEquals("bytes=0-4", host.takeRequest().getHeader("Range"))
            host.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) { webSocket.send(text) }
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
            }))
            val message = CompletableFuture<String>()
            val closed = CompletableFuture<Unit>()
            val socket = client.socket("/v1/rpc", "fixture-credential", object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) { webSocket.send("fixture") }
                override fun onMessage(webSocket: WebSocket, text: String) { message.complete(text) }
                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { closed.complete(Unit) }
            })
            assertEquals("fixture", message.get(5, TimeUnit.SECONDS))
            assertEquals("Bearer fixture-credential", host.takeRequest().getHeader("Authorization"))
            socket.close(1000, null)
            closed.get(5, TimeUnit.SECONDS)
            client.close()
        }
    }
    @Test fun wrongPinNeverReachesHttpEvenWithOtherwiseValidCertificate() {
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val other = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        server(certificate).use { host ->
            val client = PinnedTransport(host.url("/").toString().trimEnd('/'), CertificatePinner.pin(other.certificate))
            assertTrue(runCatching { client.json("/v1/pairing/prepare", org.json.JSONObject().put("ticketSecret", "fixture-only")) }.isFailure)
            assertNull(host.takeRequest(100, TimeUnit.MILLISECONDS))
            client.close()
        }
    }
    @Test fun certificateRenewalRetainsKeyButWrongNameExpiryAndRedirectAreRejected() {
        val original = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val renewed = HeldCertificate.Builder().keyPair(original.keyPair).addSubjectAlternativeName("localhost").build()
        server(renewed).use { host ->
            val client = PinnedTransport(host.url("/").toString().trimEnd('/'), CertificatePinner.pin(original.certificate))
            host.enqueue(MockResponse().setBody("{}"))
            client.json("/v1/pairing/confirm", org.json.JSONObject())
            host.takeRequest()
            host.enqueue(MockResponse().setResponseCode(302).setHeader("Location", "https://example.invalid/"))
            assertTrue(runCatching { client.json("/v1/pairing/confirm", org.json.JSONObject(), "fixture-credential") }.isFailure)
            host.takeRequest()
            val wrongName = PinnedTransport(host.url("/").toString().trimEnd('/').replace("localhost", "127.0.0.1"), CertificatePinner.pin(original.certificate))
            assertTrue(runCatching { wrongName.json("/v1/pairing/prepare", org.json.JSONObject()) }.isFailure)
            assertNull(host.takeRequest(100, TimeUnit.MILLISECONDS))
            wrongName.close(); client.close()
        }
        val expired = HeldCertificate.Builder().addSubjectAlternativeName("localhost").validityInterval(0, 1000).build()
        server(expired).use { host ->
            val client = PinnedTransport(host.url("/").toString().trimEnd('/'), CertificatePinner.pin(expired.certificate))
            assertTrue(runCatching { client.json("/v1/pairing/prepare", org.json.JSONObject()) }.isFailure)
            assertNull(host.takeRequest(100, TimeUnit.MILLISECONDS))
            client.close()
        }
    }
}
