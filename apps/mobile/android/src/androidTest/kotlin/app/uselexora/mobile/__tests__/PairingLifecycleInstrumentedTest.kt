package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.SecretStore
import okhttp3.CertificatePinner
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.time.Instant
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class PairingLifecycleInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    @Test fun delayedRemovalCannotEraseAReplacementIdentity() {
        val name = "test-identity-${UUID.randomUUID()}"
        val first = SecretStore(context, name)
        val second = SecretStore(context, name)
        try {
            val old = JSONObject().put("credential", "synthetic-first")
            first.write(old)
            val replacement = JSONObject().put("credential", "synthetic-replacement")
            second.write(replacement)
            assertFalse(first.clearIfMatches(old))
            assertEquals("synthetic-replacement", first.read()!!.getString("credential"))
            assertTrue(first.clearIfMatches(replacement))
            assertNull(second.read())
        } finally { first.clear() }
    }
    @Test fun scanningTheSameServiceRecoversAnUnreachableAddressWithoutReplacingTheDevice() {
        val secrets = SecretStore(context, "test-address-recovery-${UUID.randomUUID()}")
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        val pin = CertificatePinner.pin(certificate.certificate)
        val identity = JSONObject().put("serviceId", "service").put("profileId", "profile")
            .put("dataGeneration", "generation").put("deviceId", "device")
        val limits = JSONObject()
        val properties = schemas.document.getJSONObject("initialize").getJSONObject("output")
            .getJSONObject("properties").getJSONObject("limits").getJSONObject("properties")
        for (key in properties.keys()) limits.put(key, properties.getJSONObject(key).get("const"))
        val initialized = JSONObject(identity.toString()).put("serviceInstanceId", "instance").put("connectionId", "connection")
            .put("clientSessionId", "session").put("phase", "ready").put("serverTime", Instant.now().toString())
            .put("protocol", JSONObject().put("major", 1).put("minor", 0)).put("capabilities", JSONArray()).put("limits", limits)
        val unavailable = "https://127.0.0.1:1"
        val saved = JSONObject(identity.toString()).put("stage", "active").put("endpoint", unavailable)
            .put("credential", "existing-credential").put("spkiPin", pin)
        secrets.write(saved)
        try {
            MockWebServer().use { server ->
                server.useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
                server.dispatcher = object : Dispatcher() {
                    override fun dispatch(request: RecordedRequest): MockResponse {
                        if (request.path != "/v1/rpc" || request.getHeader("Authorization") != "Bearer existing-credential") return MockResponse().setResponseCode(401)
                        return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                            override fun onMessage(socket: WebSocket, text: String) {
                                val frame = JSONObject(text)
                                socket.send(JSONObject().put("jsonrpc", "2.0").put("id", frame.getString("id")).put("result", initialized).toString())
                            }
                            override fun onClosing(socket: WebSocket, code: Int, reason: String) { socket.close(code, reason) }
                        })
                    }
                }
                server.start()
                val reachable = server.url("/").toString().trimEnd('/')
                val qr = JSONObject().put("format", "lexora-pairing").put("version", 2)
                    .put("serviceId", "service").put("profileId", "profile").put("issuerInstanceId", "instance")
                    .put("ticketId", "ticket").put("ticketSecret", "A".repeat(43)).put("expiresAt", Instant.now().plusSeconds(60).toString())
                    .put("spkiPin", pin).put("endpoint", unavailable).put("alternateEndpoint", reachable)
                val connection = MobileConnection(context, schemas, BuildConfig.VERSION_NAME, secrets)
                val directoryId = connection.activeDeviceId()
                assertEquals("device", connection.pair(qr.toString()).deviceId)
                assertEquals(directoryId, connection.activeDeviceId())
                assertEquals("existing-credential", secrets.read()!!.getString("credential"))
                assertEquals(reachable, connection.description()!!.getString("endpoint"))
                assertEquals(unavailable, secrets.read()!!.getString("alternateEndpoint"))
            }
        } finally { secrets.clear() }
    }

    @Test fun localRemovalPreservesDraftsPendingCommandsAndDownloadedFiles() {
        val secrets = SecretStore(context)
        val previous = secrets.read()
        val partition = "test-forget-${UUID.randomUUID()}"
        val source = File(File(context.filesDir, "exports").apply { mkdirs() }, "$partition.txt").apply { writeText("保留下载的文件") }
        try {
            secrets.write(JSONObject().put("stage", "active").put("endpoint", "https://127.0.0.1:1")
                .put("serviceId", "synthetic-service").put("profileId", "synthetic-profile").put("dataGeneration", "synthetic-generation").put("deviceId", "synthetic-device").put("credential", "synthetic"))
            val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
            val connection = MobileConnection(context, schemas, BuildConfig.VERSION_NAME)
            LocalStore(context).use { store ->
                store.edit(partition, "global", JSONObject().put("content", MobileContentAdapter.textContent("没有发送的输入")))
                val envelope = JSONObject().put("commandId", UUID.randomUUID().toString())
                store.queue(partition, "chat.startTurn", envelope)
                val expected = connection.description()!!
                assertTrue(runCatching { connection.forget(JSONObject(expected.toString()).put("deviceId", "another-device")) }.isFailure)
                assertNotNull(secrets.read())
                connection.forget(expected)
                assertNull(secrets.read()); assertNull(connection.connect())
                assertEquals("没有发送的输入", MobileContentAdapter.text(store.draft(partition, "global")!!.value.getJSONObject("content")))
                assertEquals(envelope.getString("commandId"), store.outbox(partition).single().id)
                assertEquals("保留下载的文件", source.readText())
            }
        } finally { if (previous == null) secrets.clear() else secrets.write(previous); source.delete() }
    }
}
