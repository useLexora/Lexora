package app.uselexora.mobile

import android.content.Context
import android.content.ContextWrapper
import android.graphics.Bitmap
import android.graphics.Color
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
import app.uselexora.mobile.ui.ReaderAvatars
import app.uselexora.mobile.ui.ReaderTurnContext
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
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.File
import java.net.InetAddress
import java.util.UUID
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class AvatarInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var f: Fixture
    private lateinit var owner: String
    private lateinit var avatars: ReaderAvatars
    private lateinit var host: ReaderView
    private val recreation = mutableIntStateOf(0)

    @Before fun prewarmBeforeOpeningReader() {
        f = Fixture(InstrumentationRegistry.getInstrumentation().targetContext)
        f.connect()
        owner = f.client.identity!!.partition
        compose.runOnUiThread {
            avatars = ReaderAvatars(f.context, f.schemas)
            avatars.bind(owner, f.client)
        }
        awaitSource(NORTH, f.red)
        awaitSource(SOUTH, f.green)
        assertDownloads(f.red, f.green)
        compose.setContent {
            key(recreation.intValue) {
                AndroidView(factory = { ReaderView(it).also { view -> host = view } },
                    modifier = Modifier.fillMaxSize(), onRelease = { it.dispose() })
            }
        }
        until("!!document.querySelector('.reader-viewport')")
    }

    @After fun close() {
        if (!::f.isInitialized) return
        f.releaseResponse.countDown()
        try {
            compose.runOnUiThread {
                if (::host.isInitialized) host.dispose()
                if (::avatars.isInitialized) avatars.close()
            }
        } finally { f.close() }
    }

    @Test fun prewarmedAuthorsAreCorrectOnFirstDomOfBothRoundsAndOnRevisit() {
        val first = round("first", NORTH, "北辰")
        val second = round("second", SOUTH, "南星")
        val queries = f.avatarQueries.get()
        val pages = f.catalogQueries.get()
        assertTrue(pages > 0 && queries > 0)

        watchAuthor("first")
        update(first)
        expectAuthor("first", "北辰", awaitSource(NORTH, f.red))
        watchAuthor("second")
        update(first + second)
        expectAuthor("second", "南星", awaitSource(SOUTH, f.green))
        watchAuthor("revisit")
        update(round("revisit", NORTH, "北辰"), topic = "other-task")
        expectAuthor("revisit", "北辰", awaitSource(NORTH, f.red))

        assertEquals(pages, f.catalogQueries.get())
        assertEquals(queries, f.avatarQueries.get())
        assertDownloads(f.red, f.green)
        assertEquals("false", js("performance.getEntriesByType('resource').some(r => r.name.includes('/v1/'))"))
    }

    @Test fun reconnectKeepsOldImageUntilReplacementIsAvailableThenHonorsDefault() {
        val first = round("reply", NORTH, "北辰")
        watchAuthor("reply")
        update(first)
        val old = awaitSource(NORTH, f.red)
        expectAuthor("reply", "北辰", old)
        f.north = f.blue
        reconnect()
        assertTrue("Replacement GET never arrived", f.replacementRequested.await(15, TimeUnit.SECONDS))
        try {
            update(first + round("during-download", NORTH, "北辰"))
            until(decoded("during-download", old))
            assertEquals(old, source(NORTH))
            until(decoded("reply", old))
            assertEquals(listOf("北辰|$old"), trace())
        } finally { f.releaseResponse.countDown() }
        val replacement = awaitSource(NORTH, f.blue)
        until(decoded("reply", replacement))
        assertEquals(listOf("北辰|$old", "北辰|$replacement"), trace())
        assertDownloads(f.red, f.green, f.blue)

        f.north = null
        reconnect()
        assertTrue("Default metadata not requested", f.defaultReported.await(15, TimeUnit.SECONDS))
        until(bundled("reply"))
        assertNull(source(NORTH))
        assertDownloads(f.red, f.green, f.blue)
    }

    @Test fun freshOfflineReaderRestoresOnlyItsOwnPartitionsImage() {
        update(round("online", NORTH, "北辰"))
        until(decoded("online", awaitSource(NORTH, f.red)))
        val previous = host
        f.client.close()
        compose.runOnUiThread {
            host.dispose()
            avatars.close()
            avatars = ReaderAvatars(f.context, f.schemas)
            avatars.bind(owner, null)
            recreation.intValue++
        }
        compose.waitUntil(10_000) { compose.runOnUiThread { host !== previous } }
        update(round("offline", NORTH, "北辰"), topic = "offline")
        until(decoded("offline", awaitSource(NORTH, f.red)))

        watchAuthor("other")
        compose.runOnUiThread { avatars.bind("$owner-other-device", null) }
        update(round("other", NORTH, "北辰"), topic = "other-device")
        until(bundled("other"))
        assertNull(source(NORTH))
        val states = trace()
        assertTrue("Other partition: $states", states.isNotEmpty() && states.all { it.startsWith("北辰|${ReaderView.ORIGIN}/reader/") })
        assertDownloads(f.red, f.green)
    }

    private fun reconnect() {
        compose.runOnUiThread { avatars.bind(owner, null) }
        f.connect()
        assertEquals(owner, f.client.identity!!.partition)
        compose.runOnUiThread { avatars.bind(owner, f.client) }
    }

    private fun assertDownloads(vararg expected: Picture) {
        assertEquals(expected.map { it.hash }.sorted(), f.downloads.sorted())
        assertEquals(emptyList<String>(), f.rejected.toList())
    }

    private fun round(id: String, buddy: String, name: String): List<JSONObject> {
        fun body(text: String) = JSONObject().put("kind", "text").put("text", text)
        return listOf(
            JSONObject().put("id", "input-$id").put("role", "user").put("body", body("问题 $id")),
            JSONObject().put("id", id).put("runId", "run-$id").put("role", "assistant")
                .put("author", JSONObject().put("id", buddy).put("name", name)).put("body", body("回复 $id")),
        )
    }

    private fun update(messages: List<JSONObject>, topic: String = "conversation") = compose.runOnUiThread {
        host.update(messages, topic, emptyMap(), emptyList(), false, 1f, {}, {}, {},
            avatarContext = avatars, turn = ReaderTurnContext(enabled = true))
    }

    private fun source(id: String) = compose.runOnUiThread { avatars.sources[id] }
    private fun awaitSource(id: String, picture: Picture): String {
        compose.waitUntil(15_000) { source(id)?.endsWith("/${picture.hash}.png") == true }
        return requireNotNull(source(id)).also { assertTrue(it.startsWith("${ReaderView.ORIGIN}/avatars/")) }
    }

    private fun watchAuthor(id: String) {
        assertEquals("true", js("""(() => {
            window.authorObserver?.disconnect();
            window.authorTrace = [];
            const record = () => {
                const row = document.querySelector('[data-message-id="$id"]');
                if (!row && !window.authorTrace.length) return;
                const name = row?.querySelector('.author-name')?.textContent ?? '';
                const src = row?.querySelector('.message-avatar img')?.src ?? '';
                const state = name + '|' + src;
                if (window.authorTrace[window.authorTrace.length - 1] !== state) window.authorTrace.push(state);
            };
            window.authorObserver = new MutationObserver(record);
            window.authorObserver.observe(document.body, {subtree:true, childList:true, characterData:true, attributes:true, attributeFilter:['src','data-message-id']});
            return !document.querySelector('[data-message-id="$id"]');
        })()"""))
    }

    private fun trace(): List<String> = JSONArray(js("window.authorTrace")).let { a -> List(a.length()) { a.getString(it) } }
    private fun expectAuthor(id: String, name: String, src: String) {
        until(decoded(id, src))
        assertEquals("First and subsequent observed identity of $id", listOf("$name|$src"), trace())
    }
    private fun image(id: String) = "document.querySelector('[data-message-id=\"$id\"] .message-avatar img')"
    private fun decoded(id: String, src: String) = "(()=>{const i=${image(id)};return i?.src===${JSONObject.quote(src)} && i.complete && i.naturalWidth>0 && Math.max(i.naturalWidth,i.naturalHeight)<=256})()"
    private fun bundled(id: String) = "(()=>{const i=${image(id)};return i?.src.startsWith('${ReaderView.ORIGIN}/reader/') && i.complete && i.naturalWidth>0})()"
    private fun js(script: String): String {
        val result = AtomicReference<String>(); val latch = CountDownLatch(1)
        compose.runOnUiThread { (host.getChildAt(0) as WebView).evaluateJavascript(script) { result.set(it); latch.countDown() } }
        assertTrue("WebView did not answer", latch.await(5, TimeUnit.SECONDS))
        return result.get()
    }
    private fun until(script: String) {
        val deadline = android.os.SystemClock.elapsedRealtime() + 15_000
        while (android.os.SystemClock.elapsedRealtime() < deadline) {
            if (js(script) == "true") return
            Thread.sleep(50)
        }
        fail("Avatar condition: $script; observed=${js("window.authorTrace")}")
    }

    private class Picture(color: Int) {
        val bytes = Bitmap.createBitmap(512, 512, Bitmap.Config.ARGB_8888).let { bitmap ->
            try {
                bitmap.eraseColor(color)
                ByteArrayOutputStream().also { check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }.toByteArray()
            } finally { bitmap.recycle() }
        }
        val hash = AvatarCache.hash(bytes)
        fun metadata() = JSONObject().put("kind", "image").put("sha256", hash).put("mimeType", "image/png").put("sizeBytes", bytes.size)
    }

    private class Fixture(base: Context) : AutoCloseable {
        private val instance = UUID.randomUUID().toString()
        private val directory = File(base.cacheDir, "avatar-test-$instance").apply { check(mkdir()) }
        val context = object : ContextWrapper(base) {
            override fun getCacheDir() = directory
            override fun getApplicationContext(): Context = this
        }
        val schemas = ProtocolSchemas(JSONObject(base.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val red = Picture(Color.RED); val green = Picture(Color.GREEN); val blue = Picture(Color.BLUE)
        @Volatile var north: Picture? = red
        val downloads = CopyOnWriteArrayList<String>(); val rejected = CopyOnWriteArrayList<String>()
        val catalogQueries = AtomicInteger(); val avatarQueries = AtomicInteger()
        val replacementRequested = CountDownLatch(1); val releaseResponse = CountDownLatch(1); val defaultReported = CountDownLatch(1)
        private val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val server = MockWebServer()
        lateinit var client: ProductClient
            private set
        init {
            server.useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
            server.dispatcher = object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    if (request.getHeader("Authorization") != "Bearer $instance") {
                        rejected.add("Missing fixture credential: ${request.path}")
                        return MockResponse().setResponseCode(401)
                    }
                    if (request.path == "/v1/rpc") return MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                        override fun onClosing(socket: WebSocket, code: Int, reason: String) { socket.close(code, reason) }
                        override fun onMessage(socket: WebSocket, text: String) {
                            val frame = JSONObject(text)
                            val reply = JSONObject().put("jsonrpc", "2.0").put("id", frame.getString("id"))
                            try { reply.put("result", rpc(frame.getString("method"), frame.getJSONObject("params"))) }
                            catch (e: Exception) {
                                rejected.add("${frame.optString("method")}: ${e.message}")
                                reply.put("error", JSONObject().put("code", -32602).put("message", "Invalid fixture request"))
                            }
                            socket.send(reply.toString())
                        }
                    })
                    val picture = when (request.path) {
                        "/v1/avatars/$NORTH/${north?.hash}" -> north
                        "/v1/avatars/$SOUTH/${green.hash}" -> green
                        else -> null
                    }
                    if (request.method != "GET" || picture == null) {
                        rejected.add("${request.method} ${request.path}")
                        return MockResponse().setResponseCode(404)
                    }
                    downloads.add(picture.hash)
                    if (picture === blue) {
                        replacementRequested.countDown()
                        if (!releaseResponse.await(20, TimeUnit.SECONDS)) return MockResponse().setResponseCode(503)
                    }
                    return MockResponse().setHeader("Content-Type", "image/png").setHeader("ETag", "\"${picture.hash}\"").setBody(Buffer().write(picture.bytes))
                }
            }
            server.start(InetAddress.getByName("localhost"), 0)
        }
        fun connect() {
            if (::client.isInitialized) client.close()
            client = ProductClient(PinnedTransport(server.url("/").toString(), CertificatePinner.pin(certificate.certificate)), instance, schemas)
            client.connect(BuildConfig.VERSION_NAME)
        }
        private fun rpc(method: String, params: JSONObject): JSONObject = when (method) {
            "initialize" -> identity()
            "buddies.list" -> {
                require(params.isNull("cursor") && params.getInt("limit") in 1..64) { "Expected bounded first page" }
                catalogQueries.incrementAndGet()
                val profile = JSONObject().put("id", SOUTH).put("name", "目录名称").put("description", "")
                    .put("enabled", true).put("deleted", false).put("revision", "1")
                JSONObject().put("items", JSONArray().put(profile)).put("nextCursor", "later").put("catalogRevision", "1").put("defaultBuddyId", NORTH)
            }
            "buddies.getAvatars" -> {
                avatarQueries.incrementAndGet()
                val ids = params.getJSONArray("buddyIds"); val items = JSONArray()
                for (i in 0 until ids.length()) {
                    val id = ids.getString(i)
                    val picture = when (id) { NORTH -> north; SOUTH -> green; else -> error("Unknown buddy: $id") }
                    val avatar = picture?.metadata() ?: JSONObject().put("kind", "default").also { defaultReported.countDown() }
                    items.put(JSONObject().put("buddyId", id).put("avatar", avatar))
                }
                JSONObject().put("items", items)
            }
            else -> error("Unexpected method: $method")
        }
        private fun identity(): JSONObject {
            val result = JSONObject()
            for (key in listOf("serviceId", "profileId", "dataGeneration", "serviceInstanceId", "deviceId")) result.put(key, "$instance-$key")
            for (key in listOf("connectionId", "clientSessionId")) result.put(key, UUID.randomUUID().toString())
            val limits = JSONObject()
            val properties = schemas.document.getJSONObject("initialize").getJSONObject("output").getJSONObject("properties").getJSONObject("limits").getJSONObject("properties")
            for (key in properties.keys()) limits.put(key, properties.getJSONObject(key).get("const"))
            return result.put("protocol", JSONObject().put("major", 1).put("minor", 1)).put("phase", "ready")
                .put("serverTime", "2026-11-13T00:00:00.000Z").put("capabilities", JSONArray(listOf("buddies.list", "buddies.getAvatars"))).put("limits", limits)
        }
        override fun close() {
            try { if (::client.isInitialized) client.close(); server.close() } finally { directory.deleteRecursively() }
        }
    }

    private companion object {
        const val NORTH = "actor-north"
        const val SOUTH = "actor-south"
    }
}
