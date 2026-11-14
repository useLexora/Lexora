package app.uselexora.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.PinnedTransport
import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.protocol.ProductSubscription
import app.uselexora.mobile.protocol.ProtocolSchemas
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
    private class Fixture(private val snapshotRace: Boolean = false, private val malformed: Boolean = false, private val streaming: Boolean = false) : AutoCloseable {
        val schemas = ProtocolSchemas(JSONObject(InstrumentationRegistry.getInstrumentation().targetContext.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val methods = CopyOnWriteArrayList<String>()
        val acknowledgements = CopyOnWriteArrayList<String>()
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
                            if (subscriptions == 1) original = id
                            reply(JSONObject().put("subscriptionId", id).put("mode", "snapshot")
                                .put("cursor", JSONObject().put("syncEpoch", "epoch-$subscriptions").put("seq", "0"))
                                .put("items", JSONArray().put(JSONObject().put("phase", if (subscriptions == 1) "ready" else "stopping")))
                                .put("complete", true).put("nextCursor", JSONObject.NULL))
                            if (subscriptions > 1) delta(socket, original, "ready")
                        }
                        "sync.ack" -> {
                            val seq = params.getString("seq")
                            acknowledgements.add(seq)
                            if (streaming) {
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
                .put("serverTime", "2026-11-09T00:00:00.000Z").put("capabilities", JSONArray()).put("limits", limits)
        }
        override fun close() { timers.shutdownNow(); client.close(); server.close() }
    }
}
