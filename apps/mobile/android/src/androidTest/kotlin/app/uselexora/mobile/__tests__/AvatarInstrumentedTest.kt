package app.uselexora.mobile

import android.graphics.Bitmap
import android.webkit.WebView
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.viewinterop.AndroidView
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.PinnedTransport
import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.AvatarCache
import app.uselexora.mobile.ui.ReaderAvatarContext
import app.uselexora.mobile.ui.ReaderView
import okhttp3.CertificatePinner
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import okio.Buffer
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class AvatarInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var host: ReaderView
    private val recreation = mutableIntStateOf(0)
    private val messages = listOf(JSONObject().put("id", "reply").put("runId", "run").put("role", "assistant")
        .put("author", JSONObject().put("id", "default").put("name", "头像验收"))
        .put("body", JSONObject().put("kind", "text").put("text", "自定义头像与本地缓存")))

    @Test fun customAvatarsDownloadOnceRestoreOfflineAndFollowChangesWithoutCrossingIdentities() {
        Fixture().use { f ->
            compose.setContent { key(recreation.intValue) { AndroidView(factory = { ReaderView(it).also { host = it } }, modifier = Modifier.fillMaxSize(), onRelease = { it.dispose() }) } }
            val owner = f.client.identity!!.partition
            fun update(topic: String, partition: String = owner, client: ProductClient? = f.client) {
                compose.runOnUiThread { host.update(messages, topic, emptyMap(), emptyList(), false, 1f, {}, {}, {}, avatarContext = ReaderAvatarContext(partition, client, f.schemas)) }
            }
            fun custom(hash: String) = "(()=>{const i=document.querySelector('.message-avatar img');return i?.src.includes('$hash')&&i.complete&&i.naturalWidth>0&&i.naturalWidth<=256})()"
            val first = f.hash()
            update("first")
            until(custom(first))
            assertEquals(1, f.downloads.get())
            assertEquals(0, f.unauthorized.get())
            val queried = f.queries.get()
            update("second-visit")
            compose.waitUntil(10_000) { f.queries.get() > queried }
            until(custom(first))
            assertEquals(1, f.downloads.get())

            f.client.close()
            compose.runOnUiThread { recreation.intValue++ }
            compose.waitForIdle()
            update("offline-recreation", client = null)
            until(custom(first))
            assertEquals(1, f.downloads.get())
            update("other-computer", partition = "$owner-other", client = null)
            until("(()=>{const i=document.querySelector('.message-avatar img');return i?.src.includes('/reader/')&&i.naturalWidth>0})()")

            f.image = f.png(android.graphics.Color.BLUE)
            f.reconnect()
            update("updated")
            until(custom(f.hash()))
            assertEquals(2, f.downloads.get())
            f.image = null
            update("reset-default")
            until("(()=>{const i=document.querySelector('.message-avatar img');return i?.src.includes('/reader/')&&i.naturalWidth>0})()")
            assertEquals(2, f.downloads.get())
            assertEquals("false", js("performance.getEntriesByType('resource').some(r=>r.name.includes('/v1/'))"))
            compose.runOnUiThread { host.dispose() }
        }
    }

    private fun js(script: String): String {
        val result = AtomicReference<String>(); val latch = CountDownLatch(1)
        compose.runOnUiThread { (host.getChildAt(0) as WebView).evaluateJavascript(script) { result.set(it); latch.countDown() } }
        assertTrue(latch.await(5, TimeUnit.SECONDS))
        return result.get()
    }
    private fun until(script: String) {
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) { if (js(script) == "true") return; Thread.sleep(100) }
        fail("Avatar condition failed: $script; source=${js("document.querySelector('.message-avatar img')?.src")}")
    }

    private class Fixture : AutoCloseable {
        val schemas = ProtocolSchemas(JSONObject(InstrumentationRegistry.getInstrumentation().targetContext.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val downloads = AtomicInteger(); val queries = AtomicInteger(); val unauthorized = AtomicInteger()
        private val instance = UUID.randomUUID().toString()
        private val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        @Volatile var image: ByteArray? = png(android.graphics.Color.RED)
        private val server = MockWebServer()
        lateinit var client: ProductClient
            private set
        init {
            server.useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (request.getHeader("Authorization") != "Bearer avatar-fixture") { unauthorized.incrementAndGet(); return MockResponse().setResponseCode(401) }
                    if (request.path == "/v1/rpc") return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                        override fun onClosing(socket: WebSocket, code: Int, reason: String) { socket.close(code, reason) }
                        override fun onMessage(socket: WebSocket, text: String) {
                            val frame = JSONObject(text)
                            val result = if (frame.getString("method") == "initialize") identity() else {
                                queries.incrementAndGet()
                                val bytes = image
                                val avatar = if (bytes == null) JSONObject().put("kind", "default") else JSONObject().put("kind", "image").put("sha256", AvatarCache.hash(bytes)).put("mimeType", "image/png").put("sizeBytes", bytes.size)
                                JSONObject().put("items", JSONArray().put(JSONObject().put("buddyId", "default").put("avatar", avatar)))
                            }
                            socket.send(JSONObject().put("jsonrpc", "2.0").put("id", frame.getString("id")).put("result", result).toString())
                        }
                    })
                    val bytes = image ?: return MockResponse().setResponseCode(404)
                    val digest = AvatarCache.hash(bytes)
                    if (request.path != "/v1/avatars/default/$digest") return MockResponse().setResponseCode(409)
                    downloads.incrementAndGet()
                    return MockResponse().setHeader("Content-Type", "image/png").setHeader("ETag", "\"$digest\"").setBody(Buffer().write(bytes))
                }
            }
            server.start(); reconnect()
        }
        fun png(color: Int): ByteArray {
            val bitmap = Bitmap.createBitmap(2048, 2048, Bitmap.Config.ARGB_8888)
            return try { bitmap.eraseColor(color); ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray() } finally { bitmap.recycle() }
        }
        fun hash() = AvatarCache.hash(image!!)
        fun reconnect() {
            client = ProductClient(PinnedTransport(server.url("/").toString(), CertificatePinner.pin(certificate.certificate)), "avatar-fixture", schemas)
            client.connect(BuildConfig.VERSION_NAME)
        }
        private fun identity(): JSONObject {
            val result = JSONObject()
            for (key in listOf("serviceId", "profileId", "dataGeneration", "serviceInstanceId", "connectionId", "clientSessionId", "deviceId")) result.put(key, "$instance-$key")
            val limits = JSONObject()
            val properties = schemas.document.getJSONObject("initialize").getJSONObject("output").getJSONObject("properties").getJSONObject("limits").getJSONObject("properties")
            for (key in properties.keys()) limits.put(key, properties.getJSONObject(key).get("const"))
            return result.put("protocol", JSONObject().put("major", 1).put("minor", 0)).put("phase", "ready")
                .put("serverTime", "2026-11-13T00:00:00.000Z").put("capabilities", JSONArray(listOf("buddies.getAvatars"))).put("limits", limits)
        }
        override fun close() { client.close(); server.close() }
    }
}
