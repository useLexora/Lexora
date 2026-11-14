package app.uselexora.mobile.network

import app.uselexora.mobile.protocol.ProtocolFailure
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.security.MessageDigest
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.Base64
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager

class PinnedTransport(val endpoint: String, pin: String) {
    private val client: OkHttpClient
    private val closed = java.util.concurrent.atomic.AtomicBoolean(false)
    init {
        val uri = java.net.URI(endpoint)
        require(uri.scheme == "https" && uri.userInfo == null && uri.rawQuery == null && uri.rawFragment == null && (uri.path.isNullOrEmpty() || uri.path == "/"))
        val expected = Base64.getDecoder().decode(pin.removePrefix("sha256/"))
        require(expected.size == 32)
        val trust = object : X509TrustManager {
            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) { throw CertificateException("CLIENT_TLS_UNSUPPORTED") }
            override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {
                val leaf = chain.firstOrNull() ?: throw CertificateException("TLS_IDENTITY_MISMATCH")
                leaf.checkValidity()
                val actual = MessageDigest.getInstance("SHA-256").digest(leaf.publicKey.encoded)
                if (!MessageDigest.isEqual(expected, actual)) throw CertificateException("TLS_IDENTITY_MISMATCH")
            }
        }
        val ssl = SSLContext.getInstance("TLS").apply { init(null, arrayOf(trust), null) }
        client = OkHttpClient.Builder().sslSocketFactory(ssl.socketFactory, trust).followRedirects(false).followSslRedirects(false)
            .connectTimeout(10, TimeUnit.SECONDS).readTimeout(30, TimeUnit.SECONDS).pingInterval(15, TimeUnit.SECONDS).build()
    }
    fun request(path: String, method: String = "GET", body: ByteArray? = null, credential: String? = null, headers: Map<String, String> = emptyMap()): Response {
        if (closed.get()) throw ProtocolFailure("CONNECTION_CLOSED")
        require(path.startsWith("/v1/") && !path.contains(".."))
        val request = Request.Builder().url(endpoint.trimEnd('/') + path)
        if (credential != null) request.header("Authorization", "Bearer $credential")
        headers.forEach { (key, value) -> request.header(key, value) }
        request.method(method, body?.toRequestBody((headers["Content-Type"] ?: "application/json").toMediaType()))
        val response = client.newCall(request.build()).execute()
        if (response.code in 300..399) { response.close(); throw ProtocolFailure("REDIRECT_NOT_ALLOWED") }
        return response
    }
    fun json(path: String, value: JSONObject, credential: String? = null): JSONObject = request(path, "POST", value.toString().toByteArray(), credential).use { response ->
        val result = JSONObject(response.body?.string() ?: "{}")
        if (!response.isSuccessful) throw ProtocolFailure(result.optString("error", "HTTP_${response.code}"))
        result
    }
    fun socket(path: String, credential: String, listener: WebSocketListener): WebSocket {
        if (closed.get()) throw ProtocolFailure("CONNECTION_CLOSED")
        require(path.startsWith("/v1/") && !path.contains(".."))
        return client.newWebSocket(Request.Builder().url(endpoint.trimEnd('/').replaceFirst("https://", "wss://") + path).header("Authorization", "Bearer $credential").build(), listener)
    }
    fun close() {
        if (!closed.compareAndSet(false, true)) return
        cleanup.execute {
            client.dispatcher.cancelAll()
            client.connectionPool.evictAll()
            client.dispatcher.executorService.shutdown()
        }
    }
    companion object {
        private val cleanup = java.util.concurrent.Executors.newSingleThreadExecutor { action -> Thread(action, "lexora-http-close").apply { isDaemon = true } }
    }
}
