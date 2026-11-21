package app.uselexora.mobile

import app.uselexora.mobile.network.PinnedTransport
import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.protocol.ProtocolSchemas
import java.time.Instant
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import okhttp3.CertificatePinner
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONArray
import org.json.JSONObject

internal class SyntheticProductService(
    private val schemas: ProtocolSchemas,
    private val capabilities: List<String>,
    private val respond: (Call) -> Unit,
) : AutoCloseable {
    class Call(val connection: Int, private val socket: WebSocket, private val request: JSONObject) {
        val method = request.getString("method")
        val params = request.getJSONObject("params")

        fun reply(value: Any) {
            socket.send(JSONObject().put("jsonrpc", "2.0").put("id", request.getString("id")).put("result", value).toString())
        }

        fun notify(method: String, params: JSONObject) {
            socket.send(JSONObject().put("jsonrpc", "2.0").put("method", method).put("params", params).toString())
        }
    }
    private val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
    private val server = MockWebServer().apply {
        useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
        start()
    }
    private val serviceId = UUID.randomUUID().toString()
    private val connections = AtomicInteger()

    fun connect(): ProductClient {
        val connection = connections.incrementAndGet()
        server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
            override fun onMessage(webSocket: WebSocket, text: String) {
                val call = Call(connection, webSocket, JSONObject(text))
                if (call.method == "initialize") call.reply(initialization(connection)) else respond(call)
            }
        }))
        val client = ProductClient(PinnedTransport(server.url("/").toString().trimEnd('/'), CertificatePinner.pin(certificate.certificate)), "fixture-only", schemas)
        try {
            client.connect(BuildConfig.VERSION_NAME)
            return client
        } catch (failure: Exception) {
            client.close()
            throw failure
        }
    }

    private fun initialization(connection: Int): JSONObject {
        val fields = schemas.document.getJSONObject("initialize").getJSONObject("output").getJSONObject("properties").getJSONObject("limits").getJSONObject("properties")
        val limits = JSONObject().apply { for (key in fields.keys()) put(key, fields.getJSONObject(key).get("const")) }
        return JSONObject()
            .put("serviceId", serviceId).put("profileId", "fixture-profile").put("dataGeneration", "fixture-generation")
            .put("serviceInstanceId", "$serviceId-instance").put("deviceId", "fixture-device")
            .put("connectionId", "connection-$connection").put("clientSessionId", "session-$connection")
            .put("protocol", JSONObject().put("major", 1).put("minor", 0)).put("phase", "ready")
            .put("serverTime", Instant.now().toString()).put("limits", limits).put("capabilities", JSONArray(capabilities))
    }

    override fun close() = server.close()
}
