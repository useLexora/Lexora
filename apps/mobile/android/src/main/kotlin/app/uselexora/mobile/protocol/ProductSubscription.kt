package app.uselexora.mobile.protocol

import app.uselexora.mobile.network.ProductClient
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

class ProductSubscription(private val client: ProductClient, private val schemas: ProtocolSchemas,
    private val snapshot: (String, List<JSONObject>) -> Unit,
    private val changes: (String, List<JSONObject>) -> Unit,
    private val state: (String) -> Unit) {
    private val worker = Executors.newSingleThreadExecutor()
    private val queuedBytes = AtomicLong(0)
    @Volatile private var closed = false
    @Volatile private var id = UUID.randomUUID().toString()
    @Volatile private var topic = ""
    @Volatile private var recovering = false
    private var cursor: JSONObject? = null
    private var acknowledging = false
    private val selection = AtomicLong(0)
    private val removeListener = client.onNotification { frame ->
        if (frame.optJSONObject("params")?.optString("subscriptionId") == id) enqueue {
            val size = frame.toString().toByteArray().size.toLong()
            if (queuedBytes.addAndGet(size) > 1_048_576) {
                queuedBytes.addAndGet(-size)
                close()
                state("RESYNC_REQUIRED")
                client.close()
            } else worker.execute {
                try { apply(frame) } catch (_: Exception) { if (!closed) { cursor = null; close(); state("RESYNC_REQUIRED"); client.close() } }
                finally { queuedBytes.addAndGet(-size) }
            }
        }
    }
    @Synchronized private fun enqueue(action: () -> Unit) { if (!closed) action() }
    fun subscribe(name: String) = enqueue {
        if (recovering && topic == name) return@enqueue
        val requested = selection.incrementAndGet()
        worker.execute {
            if (closed || selection.get() != requested) return@execute
            try {
                if (topic.isNotEmpty()) client.exchangeAsync("sync.unsubscribe", JSONObject().put("subscriptionId", id))
                id = UUID.randomUUID().toString(); topic = name; cursor = null; acknowledging = false
                loadSafely()
            } catch (_: Exception) { if (!closed) state("UNSYNCHRONIZED") }
        }
    }
    private fun loadSafely() {
        if (closed) return
        try { load() } catch (error: Exception) {
            if (!closed) {
                if (error is ProtocolFailure && error.code == "RESYNC_REQUIRED") resynchronize()
                else state("UNSYNCHRONIZED")
            }
        }
    }
    private fun resynchronize() {
        if (closed) return
        client.exchangeAsync("sync.unsubscribe", JSONObject().put("subscriptionId", id))
        val nextId = UUID.randomUUID().toString()
        id = nextId; cursor = null; acknowledging = false; recovering = true
        state("SYNCING")
        enqueue { worker.execute { if (id == nextId) loadSafely() } }
    }
    private fun load() {
        state("SYNCING")
        val requested = selection.get()
        var page = client.exchange("sync.subscribe", JSONObject().put("subscriptionId", id).put("topic", topic))
        val schema = schemas.document.getJSONObject("sync").getJSONObject("productSyncSnapshotSchema")
        val itemSchema = topicSchema("item")
        val items = mutableListOf<JSONObject>()
        var base: String? = null
        var size = 0L
        while (true) {
            if (closed || selection.get() != requested) return
            if (!schemas.valid(page, schema) || page.optString("mode") != "snapshot" || page.optString("subscriptionId") != id) throw ProtocolFailure("SYNC_INVALID")
            val current = page.getJSONObject("cursor").toString()
            if (base != null && base != current) throw ProtocolFailure("SYNC_INVALID")
            base = current
            val values = page.getJSONArray("items")
            for (index in 0 until values.length()) {
                val value = values.getJSONObject(index)
                if (!schemas.valid(value, itemSchema)) throw ProtocolFailure("CONTENT_UNSUPPORTED")
                items.add(value)
                size += value.toString().length
            }
            if (items.size > 10_000 || size > 8_388_608) throw ProtocolFailure("LIMIT_EXCEEDED")
            if (page.getBoolean("complete")) {
                if (!page.isNull("nextCursor")) throw ProtocolFailure("SYNC_INVALID")
                break
            }
            page = client.exchange("sync.snapshotPage", JSONObject().put("subscriptionId", id).put("cursor", page.getString("nextCursor")))
        }
        if (closed) return
        snapshot(topic, items)
        cursor = page.getJSONObject("cursor")
        acknowledge()
    }
    private fun apply(frame: JSONObject) {
        if (closed) return
        val params = frame.optJSONObject("params") ?: return
        if (params.optString("subscriptionId") != id) return
        if (frame.optString("method") == "sync.resyncRequired") {
            resynchronize(); return
        }
        if (frame.optString("method") != "sync.delta") throw ProtocolFailure("SYNC_INVALID")
        val previous = cursor ?: throw ProtocolFailure("SYNC_INVALID")
        if (!schemas.valid(params, schemas.document.getJSONObject("sync").getJSONObject("productSyncDeltaSchema"))) throw ProtocolFailure("SYNC_INVALID")
        when (ProductProtocol.classifyDelta(previous.getString("syncEpoch"), previous.getString("seq"), params)) {
            "duplicate" -> return
            "resync" -> { resynchronize(); return }
        }
        val values = params.getJSONArray("changes")
        val parsed = (0 until values.length()).map { values.getJSONObject(it) }
        if (parsed.any { !schemas.valid(it, topicSchema("change")) }) throw ProtocolFailure("CONTENT_UNSUPPORTED")
        changes(topic, parsed)
        cursor = JSONObject().put("syncEpoch", params.getString("syncEpoch")).put("seq", params.getString("toSeq"))
        acknowledge()
    }
    private fun topicSchema(kind: String): JSONObject = schemas.document.getJSONObject("topics").getJSONObject(topic.substringBefore(':')).getJSONObject(kind)
    private fun acknowledge() {
        val position = cursor ?: return
        if (acknowledging || closed) return
        val subscription = id
        val captured = position.toString()
        acknowledging = true
        client.exchangeAsync("sync.ack", JSONObject(captured).put("subscriptionId", subscription)).whenComplete { _, error ->
            enqueue { worker.execute {
                if (closed || id != subscription) return@execute
                acknowledging = false
                if (error != null) {
                    val failure = generateSequence(error) { it.cause }.filterIsInstance<ProtocolFailure>().firstOrNull()
                    if (failure?.code == "RESYNC_REQUIRED") resynchronize()
                    else { state("UNSYNCHRONIZED"); client.close() }
                } else {
                    recovering = false
                    state("SYNCHRONIZED")
                    if (cursor?.toString() != captured) acknowledge()
                }
            } }
        }
    }
    @Synchronized fun close() {
        if (closed) return
        closed = true
        removeListener()
        worker.execute { if (topic.isNotEmpty() && client.isConnected) runCatching { client.exchangeAsync("sync.unsubscribe", JSONObject().put("subscriptionId", id)) } }
        worker.shutdown()
    }
}
