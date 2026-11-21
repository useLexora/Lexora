package app.uselexora.mobile.protocol

import app.uselexora.mobile.network.ProductClient
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

internal data class ProductResumePoint(val identity: ProductIdentity, val topic: String, val wire: String,
    val epoch: String, val sequence: String, val items: List<JSONObject>, val serial: Long, val recordedAt: Long) {
    fun cursor() = JSONObject().put("syncEpoch", epoch).put("seq", sequence)
    fun matches(value: JSONObject) = value.optString("syncEpoch") == epoch && value.optString("seq") == sequence
}

internal class SubscriptionProjection(private val identity: ProductIdentity, private val nextSerial: () -> Long,
    private val publish: (String, List<JSONObject>, Long) -> Unit, private val now: () -> Long = System::nanoTime) {
    private val view = ProductProjection()
    private var serial = 0L
    private var inherited: ProductResumePoint? = null
    @Volatile var checkpoint: ProductResumePoint? = null
        private set

    fun inherit(point: ProductResumePoint?) { inherited = point?.takeIf { it.identity == identity } }
    fun takeBase(topic: String, wire: String): ProductResumePoint? {
        val seed = inherited
        discard()
        return seed?.takeIf { it.topic == topic && it.wire == wire && now() - it.recordedAt in 0L..120_000_000_000L }
    }
    fun discard() { inherited = null; checkpoint = null }
    fun snapshot(topic: String, items: List<JSONObject>) { view.snapshot(topic, items); serial = nextSerial() }
    fun restore(point: ProductResumePoint) { view.snapshot(point.topic, point.items); serial = point.serial }
    fun apply(topic: String, changes: List<JSONObject>) { view.apply(topic, changes) }
    fun commit(topic: String, wire: String, cursor: JSONObject) {
        val items = view.view()
        checkpoint = if (wire.startsWith("conversationTurns:")) ProductResumePoint(identity, topic, wire,
            cursor.getString("syncEpoch"), cursor.getString("seq"), items, serial, now()) else null
        publish(topic, items, serial)
    }
}

class ProductSubscription(private val client: ProductClient, private val schemas: ProtocolSchemas,
    private val snapshot: (String, List<JSONObject>) -> Unit,
    private val changes: (String, List<JSONObject>) -> Unit,
    private val state: (String) -> Unit,
    private val failure: (Exception) -> Unit) {
    constructor(client: ProductClient, schemas: ProtocolSchemas,
        snapshot: (String, List<JSONObject>) -> Unit,
        changes: (String, List<JSONObject>) -> Unit,
        state: (String) -> Unit) : this(client, schemas, snapshot, changes, state, {})

    private var projection: SubscriptionProjection? = null
    internal constructor(client: ProductClient, schemas: ProtocolSchemas, projection: SubscriptionProjection,
        state: (String) -> Unit, failure: (Exception) -> Unit) : this(client, schemas, projection::snapshot, projection::apply, state, failure) { this.projection = projection }
    @Volatile private var queueOverflow = false
    internal val checkpoint get() = if (queueOverflow) null else projection?.checkpoint

    private val worker = Executors.newSingleThreadExecutor()
    private val queuedBytes = AtomicLong(0)
    @Volatile private var closed = false
    @Volatile private var id = UUID.randomUUID().toString()
    @Volatile private var topic = ""
    private var wireTopic = ""
    @Volatile private var recovering = false
    @Volatile private var synchronizedSelection: Long? = null
    val isSynchronized: Boolean get() = !closed && synchronizedSelection == selection.get()
    private var cursor: JSONObject? = null
    private var acknowledging = false
    private val selection = AtomicLong(0)
    private var activeSelection = 0L
    private val removeListener = client.onNotification { frame ->
        if (frame.optJSONObject("params")?.optString("subscriptionId") == id) enqueue {
            val size = frame.toString().toByteArray().size.toLong()
            if (queuedBytes.addAndGet(size) > 1_048_576) {
                queueOverflow = true
                queuedBytes.addAndGet(-size)
                close()
                state("RESYNC_REQUIRED")
                failure(ProtocolFailure("LIMIT_EXCEEDED"))
                client.close()
            } else worker.execute {
                try { apply(frame) } catch (error: Exception) { if (!closed) { fail(error, "RESYNC_REQUIRED"); close(); client.close() } }
                finally { queuedBytes.addAndGet(-size) }
            }
        }
    }
    @Synchronized private fun enqueue(action: () -> Unit) { if (!closed) action() }
    fun subscribe(name: String) = enqueue {
        if (recovering && topic == name) return@enqueue
        val requested = selection.incrementAndGet()
        synchronizedSelection = null
        worker.execute {
            if (closed || selection.get() != requested) return@execute
            try {
                if (topic.isNotEmpty()) client.exchangeAsync("sync.unsubscribe", JSONObject().put("subscriptionId", id))
                id = UUID.randomUUID().toString(); topic = name; cursor = null; acknowledging = false; recovering = false
                activeSelection = requested
                wireTopic = conversationWireTopic(name, client::supports)
                loadSafely(projection?.takeBase(name, wireTopic))
            } catch (error: Exception) { if (!closed) fail(error) }
        }
    }
    private fun loadSafely(base: ProductResumePoint? = null) {
        if (closed) return
        try { load(base) } catch (error: Exception) {
            if (!closed) {
                if (error is ProtocolFailure && (error.code == "RESYNC_REQUIRED" || base != null && error.code == "CURSOR_EXPIRED")) resynchronize()
                else fail(error)
            }
        }
    }
    private fun fail(error: Throwable, nextState: String = "UNSYNCHRONIZED") {
        if (client.isConnected) projection?.discard()
        synchronizedSelection = null
        val previous = id
        id = UUID.randomUUID().toString(); cursor = null; acknowledging = false; recovering = false
        runCatching { client.exchangeAsync("sync.unsubscribe", JSONObject().put("subscriptionId", previous)) }
        state(nextState)
        failure(generateSequence(error) { it.cause }.filterIsInstance<ProtocolFailure>().firstOrNull() ?: error as? Exception ?: ProtocolFailure("SYNC_INVALID", error))
    }
    private fun resynchronize() {
        if (closed) return
        projection?.discard()
        synchronizedSelection = null
        client.exchangeAsync("sync.unsubscribe", JSONObject().put("subscriptionId", id))
        val nextId = UUID.randomUUID().toString()
        id = nextId; cursor = null; acknowledging = false; recovering = true
        state("SYNCING")
        enqueue { worker.execute { if (id == nextId) loadSafely() } }
    }
    private fun load(resume: ProductResumePoint?) {
        val requested = activeSelection
        if (selection.get() != requested) return
        state("SYNCING")
        val params = JSONObject().put("subscriptionId", id).put("topic", wireTopic)
        if (resume != null) params.put("base", resume.cursor())
        var page = client.exchange("sync.subscribe", params)
        val schema = schemas.document.getJSONObject("sync").getJSONObject("productSyncSnapshotSchema")
        val itemSchema = topicSchema("item")
        val items = mutableListOf<JSONObject>()
        if (page.optString("mode") == "resume") {
            if (closed || selection.get() != requested) return
            if (resume == null || !schemas.valid(page, schema) || page.optString("subscriptionId") != id) throw ProtocolFailure("SYNC_INVALID")
            if (!resume.matches(page.getJSONObject("cursor"))) throw ProtocolFailure("RESYNC_REQUIRED")
            projection!!.restore(resume)
            commit(page.getJSONObject("cursor"))
            return
        }
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
        if (closed || selection.get() != requested) return
        snapshot(topic, items)
        commit(page.getJSONObject("cursor"))
    }
    private fun apply(frame: JSONObject) {
        if (closed || activeSelection != selection.get()) return
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
        try { changes(topic, parsed) } catch (error: ProtocolFailure) {
            if (error.code != "RESYNC_REQUIRED") throw error
            resynchronize(); return
        }
        commit(JSONObject().put("syncEpoch", params.getString("syncEpoch")).put("seq", params.getString("toSeq")))
    }
    private fun commit(position: JSONObject) {
        cursor = position
        projection?.commit(topic, wireTopic, position)
        acknowledge()
    }
    private fun topicSchema(kind: String): JSONObject = schemas.document.getJSONObject("topics").getJSONObject(wireTopic.substringBefore(':')).getJSONObject(kind)
    private fun acknowledge() {
        val position = cursor ?: return
        val requested = activeSelection
        if (acknowledging || closed || selection.get() != requested) return
        val subscription = id
        val captured = position.toString()
        acknowledging = true
        client.exchangeAsync("sync.ack", JSONObject(captured).put("subscriptionId", subscription)).whenComplete { _, error ->
            enqueue { worker.execute {
                if (closed || id != subscription || selection.get() != requested) return@execute
                acknowledging = false
                if (error != null) {
                    val failure = generateSequence(error) { it.cause }.filterIsInstance<ProtocolFailure>().firstOrNull()
                    if (failure?.code == "RESYNC_REQUIRED") resynchronize()
                    else { fail(failure ?: error); client.close() }
                } else {
                    recovering = false
                    synchronizedSelection = requested
                    state("SYNCHRONIZED")
                    if (cursor?.toString() != captured) acknowledge()
                }
            } }
        }
    }
    @Synchronized fun close() {
        if (closed) return
        closed = true
        synchronizedSelection = null
        removeListener()
        worker.execute { if (topic.isNotEmpty() && client.isConnected) runCatching { client.exchangeAsync("sync.unsubscribe", JSONObject().put("subscriptionId", id)) } }
        worker.shutdown()
    }
}
