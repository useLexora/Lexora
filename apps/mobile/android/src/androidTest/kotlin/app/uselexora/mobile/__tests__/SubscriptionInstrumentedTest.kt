package app.uselexora.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.PinnedTransport
import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.protocol.ProductSubscription
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.protocol.ProtocolFailure
import okhttp3.CertificatePinner
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

@RunWith(AndroidJUnit4::class)
class SubscriptionInstrumentedTest {
    @Test fun invalidatedSnapshotAndDeltaAcknowledgementsRebuildWithoutDisconnectOrBusinessReplay() {
        for ((snapshotRace, refreshDuringRecovery) in listOf(true to false, false to false, true to true)) Fixture(snapshotRace).use { fixture ->
            val phases = CopyOnWriteArrayList<String>()
            val ready = CountDownLatch(1)
            val refreshed = AtomicBoolean(false)
            lateinit var subscription: ProductSubscription
            subscription = ProductSubscription(fixture.client, fixture.schemas,
                snapshot = { _, items -> phases.add(items.single().getString("phase")) },
                changes = { _, changes -> phases.add(changes.single().getString("phase")) },
                state = {
                    if (it == "SYNCING" && refreshDuringRecovery && phases.lastOrNull() == "ready" && refreshed.compareAndSet(false, true)) subscription.subscribe("serviceState")
                    if (it == "SYNCHRONIZED" && phases.lastOrNull() == "stopping") ready.countDown()
                })
            try {
                subscription.subscribe("serviceState")
                assertTrue("Fresh snapshot was not acknowledged", ready.await(15, TimeUnit.SECONDS))
                assertTrue(fixture.client.isConnected)
                assertEquals(if (snapshotRace) listOf("ready", "stopping") else listOf("ready", "recovering", "stopping"), phases.toList())
                assertEquals(2, fixture.subscriptions)
                assertTrue(fixture.methods.all { it == "initialize" || it.startsWith("sync.") })
            } finally { subscription.close() }
        }
    }
    @Test fun malformedChangesStillCloseTheConnectionInsteadOfBeingAcknowledged() {
        Fixture(malformed = true).use { fixture ->
            val failed = CountDownLatch(1)
            val disconnected = CountDownLatch(1)
            val changes = CopyOnWriteArrayList<JSONObject>()
            fixture.client.onDisconnected = { disconnected.countDown() }
            val subscription = ProductSubscription(fixture.client, fixture.schemas,
                snapshot = { _, _ -> }, changes = { _, values -> changes.addAll(values) },
                state = { if (it == "RESYNC_REQUIRED") failed.countDown() })
            try {
                subscription.subscribe("serviceState")
                assertTrue(failed.await(15, TimeUnit.SECONDS))
                assertTrue(disconnected.await(5, TimeUnit.SECONDS))
                assertFalse(fixture.client.isConnected)
                assertTrue(changes.isEmpty())
                assertEquals(listOf("0"), fixture.acknowledgements.toList())
                assertEquals(1, fixture.subscriptions)
            } finally { subscription.close() }
        }
    }
    @Test fun delayedAcknowledgementsDoNotThrottleOrReorderStreaming() {
        Fixture(streaming = true).use { fixture ->
            val values = CopyOnWriteArrayList<Int>()
            val complete = CountDownLatch(1)
            val subscription = ProductSubscription(fixture.client, fixture.schemas,
                snapshot = { _, _ -> },
                changes = { _, _ -> values.add(values.size + 1); if (values.size == 40) complete.countDown() },
                state = {})
            val started = System.nanoTime()
            try {
                subscription.subscribe("serviceState")
                assertTrue("Streaming waited for every remote ACK response", complete.await(4, TimeUnit.SECONDS))
                assertEquals((1..40).toList(), values.toList())
                assertTrue(fixture.client.isConnected)
                assertTrue("ACKs were not coalesced", fixture.acknowledgements.size < 15)
                val evidence = JSONObject().put("frames", values.size).put("ackResponseDelayMs", 600)
                    .put("elapsedMs", (System.nanoTime() - started) / 1000000).put("acknowledgements", fixture.acknowledgements.size)
                InstrumentationRegistry.getInstrumentation().targetContext.filesDir.resolve("subscription-latency.json").writeText(evidence.toString())
            } finally { subscription.close() }
        }
    }
    @Test fun failedRecoveryKeepsPreviousProjectionAndAllowsExplicitSameTopicRetry() {
        for (code in listOf("LIMIT_EXCEEDED", "SYNC_INVALID")) Fixture(snapshotRace = true, recoveryFailure = code).use { fixture ->
            val phases = CopyOnWriteArrayList<String>()
            val states = CopyOnWriteArrayList<String>()
            val failures = CopyOnWriteArrayList<String>()
            val failed = CountDownLatch(1)
            val ready = CountDownLatch(1)
            val subscription = ProductSubscription(fixture.client, fixture.schemas,
                snapshot = { _, items -> phases.add(items.single().getString("phase")) },
                changes = { _, _ -> fail("Failed subscription must not publish stale deltas") },
                state = { states.add(it); if (it == "SYNCHRONIZED") ready.countDown() },
                failure = { failures.add((it as ProtocolFailure).code); failed.countDown() })
            try {
                subscription.subscribe("serviceState")
                assertTrue(failed.await(15, TimeUnit.SECONDS))
                assertEquals(listOf(code), failures.toList())
                assertEquals("UNSYNCHRONIZED", states.last())
                assertFalse(subscription.isSynchronized)
                assertEquals(listOf("ready"), phases.toList())
                assertTrue(fixture.client.isConnected)
                subscription.subscribe("serviceState")
                assertTrue("Explicit refresh stayed stuck in recovery", ready.await(15, TimeUnit.SECONDS))
                assertTrue(subscription.isSynchronized)
                assertEquals(listOf("ready", "stopping"), phases.toList())
                assertEquals(3, fixture.subscriptions)
                assertEquals(3, fixture.subscriptionIds.toSet().size)
                assertTrue(fixture.methods.all { it == "initialize" || it.startsWith("sync.") })
                subscription.close()
                assertFalse(subscription.isSynchronized)
            } finally { subscription.close() }
        }
    }

    @Test fun windowNegotiationPreservesCanonicalCallbackTopicAndOldCoreFallback() {
        for (supported in listOf(false, true)) Fixture(conversation = true, windowCapability = supported).use { fixture ->
            val canonical = "conversation:task:branch"
            val topics = CopyOnWriteArrayList<String>()
            val items = CopyOnWriteArrayList<JSONObject>()
            val ready = CountDownLatch(1)
            val subscription = ProductSubscription(fixture.client, fixture.schemas,
                snapshot = { topic, values -> topics.add(topic); items.addAll(values) },
                changes = { _, _ -> },
                state = { if (it == "SYNCHRONIZED") ready.countDown() })
            try {
                subscription.subscribe(canonical)
                assertTrue(ready.await(15, TimeUnit.SECONDS))
                assertEquals(listOf(if (supported) "conversationWindow:task:branch" else canonical), fixture.topics.toList())
                assertEquals(listOf(canonical), topics.toList())
                if (supported) assertEquals("historyWindow", items.single().getString("entity")) else assertTrue(items.isEmpty())
            } finally { subscription.close() }
        }
    }

    private class Fixture(private val snapshotRace: Boolean = false, private val malformed: Boolean = false,
        private val streaming: Boolean = false, private val recoveryFailure: String? = null,
        private val conversation: Boolean = false, private val windowCapability: Boolean = false) : AutoCloseable {
        val schemas = ProtocolSchemas(JSONObject(InstrumentationRegistry.getInstrumentation().targetContext.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val methods = CopyOnWriteArrayList<String>()
        val acknowledgements = CopyOnWriteArrayList<String>()
        val subscriptionIds = CopyOnWriteArrayList<String>()
        val topics = CopyOnWriteArrayList<String>()
        @Volatile var subscriptions = 0
        private val certificate = HeldCertificate.Builder().addSubjectAlternativeName("localhost").build()
        private val server = MockWebServer().apply {
            useHttps(HandshakeCertificates.Builder().heldCertificate(certificate).build().sslSocketFactory(), false)
            start()
        }
        private val timers = java.util.concurrent.Executors.newSingleThreadScheduledExecutor()
        private var original = ""
        val client: ProductClient
        init {
            server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, reason) }
                override fun onMessage(socket: WebSocket, text: String) {
                    val frame = JSONObject(text)
                    val method = frame.getString("method")
                    val params = frame.getJSONObject("params")
                    methods.add(method)
                    fun reply(value: JSONObject) { socket.send(JSONObject().put("jsonrpc", "2.0").put("id", frame.getString("id")).put("result", value).toString()) }
                    when (method) {
                        "initialize" -> reply(identity())
                        "sync.subscribe" -> {
                            subscriptions++
                            val id = params.getString("subscriptionId")
                            subscriptionIds.add(id)
                            topics.add(params.getString("topic"))
                            if (subscriptions == 1) original = id
                            val items = if (conversation) JSONArray().apply {
                                if (windowCapability) put(JSONObject("""{"entity":"historyWindow","value":{"conversationId":"task","branchId":"branch","nextCursor":null,"hasMore":false}}"""))
                            } else JSONArray().put(JSONObject().put("phase", if (subscriptions == 1) "ready" else "stopping"))
                            val incomplete = recoveryFailure != null && subscriptions == 2
                            reply(JSONObject().put("subscriptionId", id).put("mode", "snapshot")
                                .put("cursor", JSONObject().put("syncEpoch", "epoch-$subscriptions").put("seq", "0"))
                                .put("items", items)
                                .put("complete", !incomplete).put("nextCursor", if (incomplete) "next-page" else JSONObject.NULL))
                            if (subscriptions > 1) delta(socket, original, "ready")
                        }
                        "sync.snapshotPage" -> socket.send(JSONObject().put("jsonrpc", "2.0").put("id", frame.getString("id"))
                            .put("error", JSONObject().put("code", -32000).put("message", recoveryFailure)
                                .put("data", JSONObject().put("code", recoveryFailure))).toString())
                        "sync.ack" -> {
                            val seq = params.getString("seq")
                            acknowledgements.add(seq)
                            if (conversation) reply(JSONObject().put("acknowledged", true))
                            else if (streaming) {
                                if (seq == "0") {
                                    reply(JSONObject().put("acknowledged", true))
                                    for (index in 1..40) timers.schedule({
                                        socket.send(JSONObject().put("jsonrpc", "2.0").put("method", "sync.delta").put("params", JSONObject()
                                            .put("subscriptionId", original).put("syncEpoch", "epoch-1").put("fromSeq", (index - 1).toString()).put("toSeq", index.toString())
                                            .put("changes", JSONArray().put(JSONObject().put("phase", if (index % 2 == 0) "ready" else "recovering")))).toString())
                                    }, index * 25L, TimeUnit.MILLISECONDS)
                                } else timers.schedule({ reply(JSONObject().put("acknowledged", true)) }, 600, TimeUnit.MILLISECONDS)
                            } else if (subscriptions == 1 && (snapshotRace || seq == "1")) {
                                socket.send(JSONObject().put("jsonrpc", "2.0").put("id", frame.getString("id"))
                                    .put("error", JSONObject().put("code", -32000).put("message", "RESYNC_REQUIRED").put("data", JSONObject().put("code", "RESYNC_REQUIRED"))).toString())
                                socket.send(JSONObject().put("jsonrpc", "2.0").put("method", "sync.resyncRequired")
                                    .put("params", JSONObject().put("subscriptionId", original).put("reason", "RESYNC_REQUIRED")).toString())
                            } else {
                                reply(JSONObject().put("acknowledged", true))
                                if (subscriptions == 1) delta(socket, original, if (malformed) "invalid-phase" else "recovering")
                            }
                        }
                        "sync.unsubscribe" -> reply(JSONObject().put("unsubscribed", true))
                        else -> throw AssertionError("Unexpected method: $method")
                    }
                }
            }))
            client = ProductClient(PinnedTransport(server.url("/").toString().trimEnd('/'), CertificatePinner.pin(certificate.certificate)), "fixture-only", schemas)
            client.connect(BuildConfig.VERSION_NAME)
        }
        private fun delta(socket: WebSocket, id: String, phase: String) {
            socket.send(JSONObject().put("jsonrpc", "2.0").put("method", "sync.delta")
                .put("params", JSONObject().put("subscriptionId", id).put("syncEpoch", "epoch-1").put("fromSeq", "0").put("toSeq", "1")
                    .put("changes", JSONArray().put(JSONObject().put("phase", phase)))).toString())
        }
        private fun identity(): JSONObject {
            val result = JSONObject()
            for (key in listOf("serviceId", "profileId", "dataGeneration", "serviceInstanceId", "connectionId", "clientSessionId", "deviceId")) result.put(key, "fixture-$key")
            val limits = JSONObject()
            val properties = schemas.document.getJSONObject("initialize").getJSONObject("output").getJSONObject("properties").getJSONObject("limits").getJSONObject("properties")
            for (key in properties.keys()) limits.put(key, properties.getJSONObject(key).get("const"))
            return result.put("protocol", JSONObject().put("major", 1).put("minor", 0)).put("phase", "ready")
                .put("serverTime", "2026-11-09T00:00:00.000Z").put("capabilities", JSONArray().apply { if (windowCapability) put("conversations.getRecentWindow") }).put("limits", limits)
        }
        override fun close() { timers.shutdownNow(); client.close(); server.close() }
    }
}
