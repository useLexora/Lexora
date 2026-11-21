package app.uselexora.mobile.ui

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.WebResourceResponse
import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.preview.PreviewClient
import app.uselexora.mobile.preview.PreviewKind
import app.uselexora.mobile.preview.PreviewPolicy
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.AvatarCache
import app.uselexora.mobile.storage.ReadCache
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.Executors

internal fun withinThumbnailLimit(resource: JSONObject) = (resource.optString("sizeBytes").toLongOrNull() ?: 0L) in 1..20L * 1024 * 1024

class ReaderArtifactContext(val partition: String, val branchId: String, val client: ProductClient?, val schemas: ProtocolSchemas, val download: (ProductClient, JSONObject) -> File)

internal class ReaderArtifacts(private val context: Context, private val changed: () -> Unit) {
    private data class Output(val items: List<JSONObject>, val sequence: String? = null, val failed: Boolean = false)
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private val imageWorker = Executors.newSingleThreadExecutor()
    private val cache = ReadCache(File(context.cacheDir, "product-read-v1"))
    @Volatile private var generation = 0
    private var encoded: JSONObject? = null
    private var encodedLanguage = ""
    private fun publish() { encoded = null; changed() }
    var imageEpoch = Any()
        private set
    private fun publishImages() { imageEpoch = Any(); publish() }
    private var owner = ""
    private var topic = ""
    private var source: ReaderArtifactContext? = null
    private var runs = emptyList<JSONObject>()
    private var historicalRunIds = emptySet<String>()
    private val requested = mutableSetOf<String>()
    private val loading = mutableSetOf<String>()
    private val refreshQueued = mutableSetOf<String>()
    private val refreshAfter = mutableMapOf<String, Long>()
    private val imagesRequested = mutableSetOf<String>()
    private val imageWaiters = mutableMapOf<String, MutableList<(String?) -> Unit>>()
    private val outputs = mutableMapOf<String, Output>()
    @Volatile private var images = emptyMap<String, ByteArray>()

    fun update(topic: String, source: ReaderArtifactContext, runs: List<JSONObject>, history: Set<String> = emptySet()) {
        val owner = "${source.partition}:$topic:${source.branchId}"
        if (owner != this.owner || source.client !== this.source?.client) {
            generation++; loading.clear(); imagesRequested.clear(); imageWaiters.clear(); refreshQueued.clear(); refreshAfter.clear(); main.removeCallbacksAndMessages(null)
            if (owner != this.owner) { requested.clear(); outputs.clear(); images = emptyMap() }
            else outputs.replaceAll { _, output -> output.copy(sequence = null, failed = false) }
            this.owner = owner
            publishImages()
        }
        this.topic = topic; this.source = source; this.runs = runs; historicalRunIds = history
        requested.toList().forEach { load(it) }
    }

    fun request(runId: String, retry: Boolean = false) {
        if (requested.add(runId) || retry) load(runId, retry)
    }

    private fun load(runId: String, retry: Boolean = false) {
        val source = source ?: return
        val run = runs.firstOrNull { it.optString("id") == runId }
        if (run == null && runId !in historicalRunIds) return
        val sequence = run?.optString("lastEventSequence", "0") ?: "history"
        val previous = outputs[runId]
        if (runId in loading || !retry && (previous?.failed == true || previous?.sequence == sequence)) return
        val captured = generation
        val delay = (refreshAfter[runId] ?: 0L) - SystemClock.uptimeMillis()
        if (!retry && delay > 0 && run?.optString("status") in setOf("running", "queued", "awaiting_approval")) {
            if (refreshQueued.add(runId)) main.postDelayed({ if (captured == generation) { refreshQueued.remove(runId); load(runId) } }, delay)
            return
        }
        refreshAfter[runId] = SystemClock.uptimeMillis() + 1000
        val key = "outputs:$topic:${source.branchId}:$runId"
        loading.add(runId)
        worker.execute {
            if (captured != generation) return@execute
            val cached = if (previous == null) cache.read(source.partition, key)?.takeIf { items ->
                items.chunked(100).all { source.schemas.response("runs.listOutputs", JSONObject().put("items", JSONArray(it)).put("nextCursor", JSONObject.NULL)) }
            } else null
            if (!cached.isNullOrEmpty()) main.post {
                if (captured == generation && outputs[runId] == null) { outputs[runId] = Output(cached); publish() }
            }
            val connection = source.client
            if (connection?.supports("runs.listOutputs") != true || connection.identity?.partition != source.partition) {
                main.post { if (captured == generation) loading.remove(runId) }
                return@execute
            }
            val result = runCatching {
                val items = linkedMapOf<String, JSONObject>()
                var cursor: String? = null
                var restarted = false
                while (true) {
                    if (captured != generation) return@execute
                    val page = try {
                        connection.call("runs.listOutputs", JSONObject().put("runId", runId).put("branchId", source.branchId).put("cursor", cursor ?: JSONObject.NULL).put("limit", 100))
                    } catch (error: app.uselexora.mobile.protocol.ProtocolFailure) {
                        if (error.code != "CURSOR_EXPIRED" || restarted) throw error
                        restarted = true; cursor = null; items.clear(); continue
                    }
                    val values = page.getJSONArray("items")
                    for (index in 0 until values.length()) values.getJSONObject(index).let { items[it.getString("resourceId")] = it }
                    check(items.size <= 4096)
                    cursor = page.optString("nextCursor").takeUnless { it.isBlank() || it == "null" }
                    if (cursor == null) break
                }
                items.values.toList().also { cache.write(source.partition, key, it) }
            }
            main.post {
                if (captured != generation) return@post
                loading.remove(runId)
                outputs[runId] = result.fold({ Output(it, sequence) }, { Output(outputs[runId]?.items ?: previous?.items.orEmpty(), failed = true) })
                publish()
                if (result.isSuccess) load(runId)
            }
        }
    }

    fun resource(runId: String, id: String): JSONObject? = outputs[runId]?.items?.firstOrNull { it.optString("resourceId") == id }

    private fun imageKey(resource: JSONObject) = "${ReaderView.ORIGIN}/artifacts/${AvatarCache.hash("$owner:${resource.getString("resourceId")}:${resource.getString("revision")}".toByteArray())}.png"

    fun isImage(resource: JSONObject) = PreviewPolicy.kind(resource.getString("name"), resource.optString("mimeType")) == PreviewKind.IMAGE

    fun imageSource(resource: JSONObject): String? = imageKey(resource).takeIf { images.containsKey(it) }

    fun photoState(resource: JSONObject): ReaderPhotoState {
        val source = source ?: return ReaderPhotoState("unavailable")
        if (!ReaderMessagePhotos.canLoad(resource)) return ReaderPhotoState("unavailable")
        val key = imageKey(resource)
        return when {
            key in images -> ReaderPhotoState("ready", key)
            key in imageWaiters -> ReaderPhotoState("loading")
            source.client?.identity?.partition != source.partition -> ReaderPhotoState("unavailable")
            key in imagesRequested -> ReaderPhotoState("failed")
            else -> ReaderPhotoState("idle")
        }
    }

    fun requestPhoto(resource: JSONObject, retry: Boolean) {
        val status = photoState(resource).status
        if (status == "idle" || (retry && status == "failed")) thumbnailResource(resource, retry) {}
    }

    fun thumbnail(runId: String, id: String) {
        resource(runId, id)?.let { thumbnailResource(it) {} }
    }

    fun thumbnailResource(resource: JSONObject, retry: Boolean = false, complete: (String?) -> Unit) {
        val source = source
        val connection = source?.client
        if (source == null || connection == null || connection.identity?.partition != source.partition || !isImage(resource) || !withinThumbnailLimit(resource)) { complete(null); return }
        val key = imageKey(resource)
        imageWaiters[key]?.let { it.add(complete); return }
        if (!retry && images.containsKey(key)) { complete(key); return }
        if (!imagesRequested.add(key) && !retry) { complete(null); return }
        if (retry) images = images - key
        imageWaiters[key] = mutableListOf(complete)
        publishImages()
        val captured = generation
        imageWorker.execute {
            if (captured != generation) return@execute
            val bytes = runCatching {
                val file = source.download(connection, resource)
                if (captured != generation) return@execute
                PreviewClient(context).use { preview ->
                    val bitmap = checkNotNull(preview.render(file, PreviewKind.IMAGE).bitmap)
                    try {
                        val scale = minOf(1.0, 320.0 / maxOf(bitmap.width, bitmap.height))
                        val small = Bitmap.createScaledBitmap(bitmap, maxOf(1, (bitmap.width * scale).toInt()), maxOf(1, (bitmap.height * scale).toInt()), true)
                        try { ByteArrayOutputStream().also { check(small.compress(Bitmap.CompressFormat.PNG, 100, it)) }.toByteArray().also { check(it.size <= 512 * 1024) } }
                        finally { if (small !== bitmap) small.recycle() }
                    } finally { bitmap.recycle() }
                }
            }.getOrNull()
            main.post {
                if (captured != generation) return@post
                if (bytes != null) {
                    val next = LinkedHashMap(images)
                    next[key] = bytes
                    while (next.size > 32 || next.values.sumOf { it.size } > 8 * 1024 * 1024) {
                        val removed = next.keys.first(); next.remove(removed); imagesRequested.remove(removed)
                    }
                    images = next
                }
                imageWaiters.remove(key)?.forEach { it(key.takeIf { bytes != null }) }
                publishImages()
            }
        }
    }

    fun wire(): JSONObject {
        val language = MobileAppearance.language
        if (language == encodedLanguage) encoded?.let { return it }
        val value = JSONObject(outputs.mapValues { (_, output) ->
        JSONObject().put("failed", output.failed).put("items", JSONArray(output.items.map { resource ->
            val label = MobileReadingPolicy.resource(resource)
            JSONObject().put("id", resource.getString("resourceId")).put("name", label.name)
                .put("revision", resource.getString("revision")).put("description", listOfNotNull(label.type, label.size, label.status.takeIf { !label.available }).joinToString(" · "))
                .put("available", label.available).put("image", PreviewPolicy.kind(resource.getString("name"), resource.optString("mimeType")) == PreviewKind.IMAGE)
                .put("thumbnail", imageKey(resource).takeIf { images.containsKey(it) } ?: JSONObject.NULL)
        }))
        })
        encoded = value; encodedLanguage = language
        return value
    }

    fun asset(uri: Uri): WebResourceResponse? = images[uri.toString()]?.let {
        WebResourceResponse("image/png", null, 200, "OK", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(it))
    }

    fun close() { generation++; main.removeCallbacksAndMessages(null); images = emptyMap(); worker.shutdownNow(); imageWorker.shutdownNow() }
}
