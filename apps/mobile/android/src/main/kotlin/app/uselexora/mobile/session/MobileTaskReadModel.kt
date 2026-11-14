package app.uselexora.mobile.session

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import android.os.Handler
import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.ReadCache
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

class MobileTaskReadModel(
    private val cache: ReadCache,
    private val schemas: ProtocolSchemas,
    private val handler: Handler,
    private val context: () -> Context,
    private val work: (() -> Unit) -> Unit,
    private val onUi: (() -> Unit) -> Unit,
    private val catalogChanged: (Catalog) -> Unit,
    private val marksChanged: (Marks) -> Unit,
    private val cachedTasks: () -> Unit,
    private val cachedConversation: (List<JSONObject>?, List<JSONObject>?) -> Unit,
) {
    data class Context(val partition: String, val topic: String, val client: ProductClient?, val generation: Long)
    data class Catalog(val items: List<JSONObject> = emptyList(), val loading: Boolean = false, val error: String = "")
    data class Marks(val ids: Set<String> = emptySet(), val loaded: Boolean = false, val failed: Boolean = false)
    private data class MarksRequest(val context: Context, val generation: Long, val taskIds: List<String>)
    var tasks = emptyList<JSONObject>()
        private set
    private var catalog = Catalog()
    private var marks = Marks()
    private val cacheWorker = Executors.newSingleThreadExecutor()
    private val catalogWorker = Executors.newSingleThreadExecutor()
    @Volatile private var closed = false
    private var cacheSave: Runnable? = null
    private var pendingReadCache: (() -> Unit)? = null
    private var cachedTopicRequest = 0L
    private var projectionRevision = 0L
    private var catalogOwner = ""
    private var catalogClient: ProductClient? = null
    private var catalogLoading: ProductClient? = null
    @Volatile private var marksGeneration = 0L
    private var marksLoading = false
    private var pendingMarks: MarksRequest? = null

    fun replaceTasks(value: List<JSONObject>) { tasks = value }
    private fun sameConnection(captured: Context): Boolean {
        val current = context()
        return !closed && current.partition == captured.partition && current.client === captured.client && current.generation == captured.generation
    }
    private fun publishCatalog(value: Catalog) { catalog = value; catalogChanged(value) }
    private fun publishMarks(value: Marks) { marks = value; marksChanged(value) }
    fun resetMarks() { marksGeneration++; pendingMarks = null; publishMarks(Marks()) }
    fun refreshMarks() {
        val captured = context()
        val client = captured.client?.takeIf { it.isConnected && it.identity?.partition == captured.partition } ?: return
        pendingMarks = MarksRequest(captured.copy(client = client), ++marksGeneration, tasks.map { it.getString("id") }.distinct())
        loadMarks()
    }
    private fun loadMarks() {
        if (marksLoading) return
        val request = pendingMarks ?: return
        pendingMarks = null
        if (!sameConnection(request.context)) return
        val client = request.context.client!!
        marksLoading = true
        work {
            val result = runCatching {
                if (marksGeneration != request.generation || !sameConnection(request.context)) return@runCatching null
                if (!client.supports("taskMarks.states")) throw ProtocolFailure("METHOD_NOT_AVAILABLE")
                val marked = mutableSetOf<String>()
                for (batch in request.taskIds.chunked(100)) {
                    if (marksGeneration != request.generation || !sameConnection(request.context)) return@runCatching null
                    val response = client.callValue("taskMarks.states", JSONObject().put("conversationIds", JSONArray(batch))) as? JSONArray
                        ?: throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
                    val states = objects(response)
                    if (states.size != batch.size || states.map { it.getString("conversationId") }.toSet() != batch.toSet()) throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
                    states.filter { !it.isNull("markId") }.forEach { marked.add(it.getString("conversationId")) }
                }
                marked.toSet()
            }
            onUi {
                marksLoading = false
                if (sameConnection(request.context) && marksGeneration == request.generation) {
                    result.fold(onSuccess = { if (it != null) publishMarks(Marks(it, loaded = true)) },
                        onFailure = { publishMarks(marks.copy(failed = true)) })
                }
                loadMarks()
            }
        }
    }
    fun refreshCatalog(client: ProductClient, force: Boolean = false) {
        if ((!force && catalogClient === client) || catalogLoading === client) return
        val captured = context()
        catalogLoading = client
        publishCatalog(catalog.copy(loading = catalog.items.isEmpty(), error = ""))
        catalogWorker.execute {
            try {
                val values = mutableListOf<JSONObject>()
                var cursor: String? = null
                val seen = mutableSetOf<String>()
                do {
                    val page = client.call("providers.listModels", JSONObject().put("cursor", cursor ?: JSONObject.NULL))
                    values.addAll(objects(page.getJSONArray("items")).filter { it.optBoolean("available") && it.optBoolean("enabled") && it.optString("type") == "chat" })
                    cursor = page.opt("nextCursor") as? String
                    if (cursor != null && !seen.add(cursor)) throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
                } while (cursor != null)
                cacheWorker.execute { runCatching { cache.write(captured.partition, "models", values) } }
                onUi { if (sameConnection(captured)) { catalogClient = client; publishCatalog(Catalog(values)) } }
            } catch (_: Exception) {
                onUi { if (sameConnection(captured)) publishCatalog(catalog.copy(loading = false, error = if (catalog.items.isEmpty()) mobileText(R.string.models_load_failed) else mobileText(R.string.models_cached))) }
            } finally { onUi { if (catalogLoading === client) catalogLoading = null } }
        }
    }
    fun restoreCatalogs() {
        val captured = context()
        if (catalogOwner != captured.partition) { catalogOwner = captured.partition; catalogClient = null; publishCatalog(Catalog()) }
        val revision = projectionRevision
        cacheWorker.execute {
            val models = cache.read(captured.partition, "models")?.takeIf { values -> values.chunked(100).all { schemas.response("providers.listModels", JSONObject().put("items", JSONArray(it)).put("nextCursor", JSONObject.NULL)) } }
            val tasks = cache.read(captured.partition, "taskIndex")?.takeIf { values -> values.all { schemas.valid(it, schemas.document.getJSONObject("topics").getJSONObject("taskIndex").getJSONObject("item")) } }
            onUi {
                if (closed || context().partition != captured.partition) return@onUi
                if ((catalogClient !== context().client || context().client == null) && catalog.items.isEmpty() && models != null) publishCatalog(catalog.copy(items = models))
                if (projectionRevision == revision && this.tasks.isEmpty() && tasks != null) { this.tasks = tasks; cachedTasks() }
            }
        }
    }
    fun restoreConversation(taskId: String) {
        val captured = context()
        val request = ++cachedTopicRequest
        val revision = projectionRevision
        cacheWorker.execute {
            val items = cache.read(captured.partition, captured.topic)?.takeIf { values -> values.all { schemas.valid(it, schemas.document.getJSONObject("topics").getJSONObject("conversation").getJSONObject("item")) } }
            val branches = cache.read(captured.partition, "branches:$taskId")?.takeIf { values -> values.chunked(100).all { schemas.response("conversations.listBranches", JSONObject().put("items", JSONArray(it)).put("nextCursor", JSONObject.NULL)) } }
            onUi {
                val current = context()
                if (closed || current.partition != captured.partition || current.topic != captured.topic || cachedTopicRequest != request || projectionRevision != revision) return@onUi
                if (items != null) cachedConversation(items.filter { it.optString("entity") == "message" }.map { it.getJSONObject("value") }, branches)
                else if (branches != null) cachedConversation(null, branches)
            }
        }
    }
    fun rememberBranches(owner: String, taskId: String, branches: List<JSONObject>) {
        if (closed) return
        cacheWorker.execute { runCatching { cache.write(owner, "branches:$taskId", branches) } }
    }
    fun committed(topic: String, items: List<JSONObject>) {
        projectionRevision++
        val owner = context().partition
        val values = if (topic == "taskIndex") items else items.filter { it.optString("entity") == "message" }
        pendingReadCache = { runCatching { cache.write(owner, topic, values) }; Unit }
        if (cacheSave == null) cacheSave = Runnable { flush() }.also { handler.postDelayed(it, 1500) }
    }
    fun resetTopic() { flush(); cachedTopicRequest++ }
    fun flush() {
        cacheSave?.let(handler::removeCallbacks); cacheSave = null
        pendingReadCache?.let { cacheWorker.execute(it) }; pendingReadCache = null
    }
    fun close() {
        if (closed) return
        closed = true
        flush()
        catalogWorker.execute { cacheWorker.shutdown() }
        catalogWorker.shutdown()
    }
    private fun objects(array: JSONArray) = (0 until array.length()).map { array.getJSONObject(it) }
}

