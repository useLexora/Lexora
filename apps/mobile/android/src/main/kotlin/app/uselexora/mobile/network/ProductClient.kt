package app.uselexora.mobile.network

import android.os.SystemClock
import java.time.Instant
import app.uselexora.mobile.protocol.ServiceTime
import app.uselexora.mobile.protocol.ProductIdentity
import app.uselexora.mobile.protocol.ProductProtocol
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.protocol.ProtocolSchemas
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.Executors
import java.util.concurrent.TimeoutException

class ProductClient(private val transport: PinnedTransport, private val credential: String, private val schemas: ProtocolSchemas) {
    private val pending = ConcurrentHashMap<String, CompletableFuture<JSONObject>>()
    private val deadlines = Executors.newSingleThreadScheduledExecutor()
    private var socket: WebSocket? = null
    private var connection = 0L
    var identity: ProductIdentity? = null
        private set
    @Volatile private var socketOpen = false
    val isConnected: Boolean get() = socketOpen && identity != null
    private var serviceTime: ServiceTime? = null
    private var capabilities = emptySet<String>()
    fun supports(method: String) = isConnected && method in capabilities
    fun readAvatar(buddyId: String, avatar: JSONObject): ByteArray {
        val hash = avatar.getString("sha256")
        val size = avatar.getInt("sizeBytes")
        require(hash.matches(Regex("[a-f0-9]{64}")) && size in 1..2 * 1024 * 1024)
        val id = java.net.URLEncoder.encode(buddyId, "UTF-8").replace("+", "%20")
        return transport.request("/v1/avatars/$id/$hash", credential = credential).use { response ->
            if (!response.isSuccessful) throw ProtocolFailure("RESOURCE_UNAVAILABLE")
            val body = response.body ?: throw ProtocolFailure("RESOURCE_UNAVAILABLE")
            if (body.contentType()?.toString()?.substringBefore(';') != avatar.getString("mimeType") || response.header("ETag") != "\"$hash\"") throw ProtocolFailure("VERSION_CHANGED")
            val source = body.source()
            source.request(size.toLong() + 1)
            if (source.buffer.size != size.toLong()) throw ProtocolFailure("RESOURCE_UNAVAILABLE")
            source.readByteArray()
        }
    }
    var onDisconnected: () -> Unit = {}
    private val notifications = CopyOnWriteArrayList<(JSONObject) -> Unit>()
    fun onNotification(listener: (JSONObject) -> Unit): () -> Unit {
        notifications.add(listener)
        return { notifications.remove(listener) }
    }
    fun connect(version: String): ProductIdentity {
        val ready = CompletableFuture<Unit>()
        val generation = ++connection
        socket = transport.socket("/v1/rpc", credential, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) { if (generation == connection) { socketOpen = true; ready.complete(Unit) } else webSocket.close(1000, null) }
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (generation != connection) return
                try {
                    if (text.toByteArray().size > 1_048_576) throw ProtocolFailure("FRAME_TOO_LARGE")
                    val frame = JSONObject(text)
                    if (frame.has("id")) pending.remove(frame.getString("id"))?.complete(frame) else notifications.forEach { it(frame) }
                } catch (error: Exception) { fail(error); webSocket.close(1002, "Invalid product frame") }
            }
            override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) {
                val failure = if (response?.code == 401) ProtocolFailure("NOT_AUTHORIZED", error) else error
                response?.close()
                if (generation == connection) { ready.completeExceptionally(failure); fail(failure) }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { if (generation == connection) fail(ProtocolFailure("SERVICE_UNREACHABLE")) }
        })
        ready.get(15, TimeUnit.SECONDS)
        val requestStarted = SystemClock.elapsedRealtimeNanos()
        val result = call("initialize", ProductProtocol.initialize(version))
        if (!socketOpen) throw ProtocolFailure("SERVICE_UNREACHABLE")
        capabilities = result.getJSONArray("capabilities").let { values -> (0 until values.length()).map { values.getString(it) }.toSet() }
        serviceTime = ServiceTime(Instant.parse(result.getString("serverTime")), requestStarted)
        return ProductIdentity.parse(result).also { identity = it }
    }
    fun serverNow(): Instant {
        if (!socketOpen || identity == null) throw ProtocolFailure("NOT_CONNECTED")
        return serviceTime?.now(SystemClock.elapsedRealtimeNanos()) ?: throw ProtocolFailure("REVIEW_REQUIRED")
    }
    fun validateRequest(method: String, params: JSONObject) { if (!schemas.request(method, params)) throw ProtocolFailure("INVALID_PARAMS") }
    fun call(method: String, params: JSONObject): JSONObject = callValue(method, params) as? JSONObject ?: throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
    fun callValue(method: String, params: JSONObject): Any {
        validateRequest(method, params)
        val result = exchangeValue(method, params)
        if (!schemas.response(method, result)) throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
        return result
    }
    fun exchange(method: String, params: JSONObject): JSONObject = exchangeValue(method, params) as? JSONObject ?: throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
    private fun exchangeValue(method: String, params: JSONObject): Any = try { exchangeAsync(method, params).get(30, TimeUnit.SECONDS) }
        catch (error: java.util.concurrent.ExecutionException) { throw error.cause ?: error }
    fun exchangeAsync(method: String, params: JSONObject): CompletableFuture<Any> {
        if (pending.size >= 64) throw ProtocolFailure("TOO_MANY_REQUESTS")
        val id = UUID.randomUUID().toString()
        val response = CompletableFuture<JSONObject>()
        pending[id] = response
        response.whenComplete { _, _ -> pending.remove(id) }
        try {
            val timeout = deadlines.schedule({ response.completeExceptionally(TimeoutException("Product request timed out")) }, 30, TimeUnit.SECONDS)
            response.whenComplete { _, _ -> timeout.cancel(false) }
            val frame = JSONObject().put("jsonrpc", "2.0").put("id", id).put("method", method).put("params", params).toString()
            if (frame.toByteArray().size > 1_048_576) throw ProtocolFailure("FRAME_TOO_LARGE")
            if (socket?.send(frame) != true) throw ProtocolFailure("SERVICE_UNREACHABLE")
        } catch (error: Exception) { response.completeExceptionally(error) }
        return response.thenApply { received ->
            received.optJSONObject("error")?.let { error -> throw ProtocolFailure(error.optJSONObject("data")?.optString("code") ?: error.optString("message", "REQUEST_FAILED")) }
            if (received.has("result")) received.get("result") else throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
        }
    }
    fun close() { ++connection; socket?.close(1000, null); socket = null; identity = null; fail(ProtocolFailure("CONNECTION_CLOSED")); transport.close(); deadlines.shutdownNow() }
    private fun fail(error: Throwable) { socketOpen = false; pending.values.forEach { it.completeExceptionally(error) }; pending.clear(); runCatching { onDisconnected() } }
}
