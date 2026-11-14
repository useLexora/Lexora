package app.uselexora.mobile.ui

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.WebResourceResponse
import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.AvatarCache
import app.uselexora.mobile.storage.ReadCache
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicLong

data class ReaderAvatarContext(val partition: String, val client: ProductClient?, val schemas: ProtocolSchemas)

class ReaderAvatars(context: Context, private val schemas: ProtocolSchemas, private val changed: () -> Unit) {
    private val images = AvatarCache(File(context.cacheDir, "buddy-avatars-v1"))
    private val metadata = ReadCache(File(context.cacheDir, "product-read-v1"))
    private val worker = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    private val generation = AtomicLong()
    private var partition = ""
    private var topic = ""
    private var client: ProductClient? = null
    private var ids = emptySet<String>()
    private var closed = false
    var sources: Map<String, String> = emptyMap()
        private set
    private data class Asset(val partition: String, val avatar: JSONObject)
    @Volatile private var assets = emptyMap<String, Asset>()
    private val refresh = Runnable { load() }

    fun update(partition: String, topic: String, client: ProductClient?, ids: Set<String>) {
        if (closed || this.partition == partition && this.topic == topic && this.client === client && this.ids == ids) return
        if (this.partition != partition) { sources = emptyMap(); assets = emptyMap(); changed() }
        this.partition = partition; this.topic = topic; this.client = client; this.ids = ids
        generation.incrementAndGet()
        handler.removeCallbacks(refresh)
        load()
    }

    private fun load() {
        if (closed || partition.isBlank() || ids.isEmpty()) return
        val request = generation.get(); val owner = partition; val current = client; val requested = ids
        worker.execute {
            if (generation.get() != request) return@execute
            val previous = metadata.read(owner, "avatars").orEmpty().filter { valid(it) }
            val cached = previous.filter { it.optString("buddyId") in requested }
            publish(owner, cached, request)
            if (current?.supports("buddies.getAvatars") == true && current.identity?.partition == owner) runCatching {
                val records = requested.chunked(100).flatMap { batch ->
                    if (generation.get() != request) return@execute
                    val result = current.call("buddies.getAvatars", JSONObject().put("buddyIds", JSONArray(batch))).getJSONArray("items")
                    (0 until result.length()).map { result.getJSONObject(it) }.also { items -> require(items.map { it.getString("buddyId") }.toSet() == batch.toSet()) }
                }
                if (generation.get() != request) return@execute
                metadata.write(owner, "avatars", (previous.filter { it.getString("buddyId") !in requested } + records).takeLast(1000))
                publish(owner, records, request)
                for (record in records) {
                    if (generation.get() != request) return@execute
                    val avatar = record.getJSONObject("avatar")
                    if (avatar.optString("kind") != "image" || images.read(owner, avatar) != null) continue
                    runCatching { images.write(owner, avatar, current.readAvatar(record.getString("buddyId"), avatar)) }
                    publish(owner, records, request)
                }
            }
            handler.post { if (!closed && generation.get() == request && current?.isConnected == true) { handler.removeCallbacks(refresh); handler.postDelayed(refresh, 60_000) } }
        }
    }

    private fun valid(record: JSONObject) = schemas.response("buddies.getAvatars", JSONObject().put("items", JSONArray(listOf(record))))

    private fun publish(owner: String, records: List<JSONObject>, request: Long) {
        val next = mutableMapOf<String, String>()
        val available = mutableMapOf<String, Asset>()
        for (record in records) {
            val avatar = record.getJSONObject("avatar")
            when (avatar.getString("kind")) {
                "preset" -> next[record.getString("buddyId")] = "preset:${avatar.getString("preset")}"
                "image" -> if (images.read(owner, avatar) != null) {
                    val url = "${ReaderView.ORIGIN}/avatars/${AvatarCache.hash(owner.toByteArray())}/${avatar.getString("sha256")}.png"
                    next[record.getString("buddyId")] = url
                    available[url] = Asset(owner, avatar)
                }
            }
        }
        handler.post {
            if (closed || generation.get() != request) return@post
            assets = available
            if (sources != next) { sources = next; changed() }
        }
    }

    fun asset(uri: Uri): WebResourceResponse? {
        val asset = assets[uri.toString()] ?: return null
        val bytes = images.read(asset.partition, asset.avatar) ?: return null
        return runCatching {
            val options = BitmapFactory.Options().apply { inJustDecodeBounds = true; inSampleSize = 1 }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
            require(options.outWidth > 0 && options.outHeight > 0 && options.outWidth.toLong() * options.outHeight <= 25_000_000)
            options.inJustDecodeBounds = false
            while (maxOf(options.outWidth, options.outHeight) / options.inSampleSize > 256) options.inSampleSize *= 2
            val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: return null
            val output = ByteArrayOutputStream()
            try { require(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) } finally { bitmap.recycle() }
            WebResourceResponse("image/png", null, 200, "OK", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(output.toByteArray()))
        }.getOrNull()
    }

    fun close() { closed = true; generation.incrementAndGet(); handler.removeCallbacks(refresh); assets = emptyMap(); worker.shutdownNow() }
}
