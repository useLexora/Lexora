package app.uselexora.mobile.ui

import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

internal data class ReaderToolImageId(val runId: String, val toolCallId: String, val kind: String, val id: String) {
    fun wire() = JSONObject().put("runId", runId).put("toolCallId", toolCallId).put("kind", kind).put("id", id)

    fun resources(transcripts: Map<String, JSONObject>): List<String> {
        if (kind !in setOf("artifact", "reference") || id.isBlank() || ':' in id) return emptyList()
        val events = transcripts[runId]?.optJSONArray("events") ?: return emptyList()
        for (index in events.length() - 1 downTo 0) {
            val event = events.optJSONObject(index) ?: continue
            if (event.optString("runId") != runId) continue
            val payload = event.optJSONObject("payload") ?: continue
            if (payload.optString("toolCallId") != toolCallId) continue
            if (event.optString("type") == "tool.denied") return emptyList()
            val presentation = payload.optJSONObject("presentation") ?: continue
            if (presentation.optString("card") != "image") return emptyList()
            val reference = presentation.optJSONObject("reference")
            val ids = if (kind == "artifact") presentation.optJSONArray("artifactIds")
                else reference?.takeIf { it.optString("mode") == "resources" }?.optJSONArray("resourceIds")
            if (ids == null || (0 until ids.length()).none { ids.optString(it) == id }) return emptyList()
            return if (kind == "artifact") listOf("artifact:$id") else listOf("attachment:$id", "artifact:$id")
        }
        return emptyList()
    }

    companion object {
        fun from(data: JSONObject) = ReaderToolImageId(data.getString("runId"), data.getString("toolCallId"), data.getString("kind"), data.getString("id"))
    }
}

internal class ReaderToolImages(private val images: ReaderArtifacts, private val changed: () -> Unit) {
    private data class State(val resource: JSONObject? = null, val loading: Boolean = true, val failed: Boolean = false)
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    @Volatile private var generation = 0
    private var source: ReaderArtifactContext? = null
    private var owner = ""
    private var connected = false
    private var transcripts = emptyMap<String, JSONObject>()
    private var runIds = emptySet<String>()
    private val states = linkedMapOf<ReaderToolImageId, State>()
    private var encoded: JSONArray? = null
    private fun publish() { encoded = null; changed() }

    fun update(topic: String, source: ReaderArtifactContext, runs: List<JSONObject>, transcripts: Map<String, JSONObject>) {
        val nextOwner = "${source.partition}:$topic:${source.branchId}"
        val connected = source.client?.isConnected == true && source.client.identity?.partition == source.partition
        if (owner != nextOwner || this.source?.client !== source.client || this.connected != connected) {
            generation++; main.removeCallbacksAndMessages(null)
            if (owner != nextOwner) states.clear()
            else states.replaceAll { _, state -> state.copy(loading = false, failed = false) }
            publish()
        }
        owner = nextOwner; this.connected = connected; this.source = source; this.runIds = runs.map { it.getString("id") }.toSet()
        if (this.transcripts !== transcripts) {
            this.transcripts = transcripts
            if (states.keys.removeAll { !allowed(it) }) publish()
        }
    }

    private fun allowed(id: ReaderToolImageId) = id.runId in runIds && id.resources(transcripts).isNotEmpty()

    fun resource(id: ReaderToolImageId): JSONObject? = states[id]?.resource?.takeIf { allowed(id) && MobileReadingPolicy.resource(it).available }

    fun request(id: ReaderToolImageId, retry: Boolean) {
        if (!allowed(id)) return
        val previous = states[id]
        if (previous?.loading == true || !retry && (previous?.failed == true || previous?.resource?.let { images.imageSource(it) } != null)) return
        val source = source ?: return
        val connection = source.client
        val candidates = id.resources(transcripts)
        val state = State()
        if (states.size >= 128 && id !in states) {
            val oldest = states.entries.firstOrNull { !it.value.loading }?.key ?: return
            states.remove(oldest)
        }
        states[id] = state; publish()
        val captured = generation
        worker.execute {
            if (captured != generation) return@execute
            val resource = runCatching {
                check(connection?.supports("resources.get") == true && connection.identity?.partition == source.partition)
                candidates.firstNotNullOfOrNull { candidate ->
                    (connection!!.callValue("resources.get", JSONObject().put("resourceId", candidate)) as? JSONObject)?.takeIf { it.optString("resourceId") == candidate }
                }?.takeIf { MobileReadingPolicy.resource(it).available && images.isImage(it) }
            }.getOrNull()
            main.post {
                if (captured != generation || states[id] !== state || !allowed(id)) return@post
                if (resource == null) { states[id] = State(loading = false, failed = true); publish(); return@post }
                states[id] = State(resource)
                publish()
                images.thumbnailResource(resource, retry) { thumbnail ->
                    if (captured == generation && allowed(id)) {
                        states[id] = State(resource, loading = false, failed = thumbnail == null)
                        publish()
                    }
                }
            }
        }
    }

    fun wire(): JSONArray {
        encoded?.let { return it }
        return JSONArray(states.map { (id, state) ->
            id.wire().put("name", state.resource?.optString("name").orEmpty())
                .put("thumbnail", state.resource?.let { images.imageSource(it) } ?: JSONObject.NULL)
                .put("loading", state.loading).put("failed", state.failed).put("available", state.resource != null)
        }).also { encoded = it }
    }

    fun invalidateImages() { encoded = null }
    fun close() { generation++; states.clear(); main.removeCallbacksAndMessages(null); worker.shutdownNow() }
}
