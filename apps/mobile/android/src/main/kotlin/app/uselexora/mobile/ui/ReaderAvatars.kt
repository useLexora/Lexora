package app.uselexora.mobile.ui

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.AvatarCache
import app.uselexora.mobile.storage.ReadCache
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

class ReaderAvatars(context: Context, private val schemas: ProtocolSchemas) {
    private class Partition(val id: String) {
        val prefix = "${ReaderView.ORIGIN}/avatars/${AvatarCache.hash(id.toByteArray())}/"
        var restored = false
        var directory = emptyMap<String, String>()
        val records = linkedMapOf<String, JSONObject>()
        val thumbnails = linkedMapOf<String, ReaderAvatarImage>()
    }
    private class Binding(val owner: Partition, val client: ProductClient?) {
        val checked = mutableSetOf<String>()
        var warm = emptySet<String>()
        var catalogRevision = ""
        var cursor: String? = null
    }
    private data class Observer(val ids: Set<String>, val nameIds: Set<String>, val changed: () -> Unit)
    private val observers = mutableMapOf<Any, Observer>()
    private val images = AvatarCache(File(context.cacheDir, "buddy-avatars-v1"))
    private val metadata = ReadCache(File(context.cacheDir, "product-read-v1"))
    private val worker = Executors.newSingleThreadExecutor()
    private val handler = Handler(Looper.getMainLooper())
    @Volatile private var binding: Binding? = null
    private var recent = emptySet<String>()
    private var closed = false
    var restoring = true
        private set
    var sources = emptyMap<String, String>()
        private set
    var names = emptyMap<String, String>()
        private set
    @Volatile private var assets = emptyMap<String, ReaderAvatarImage>()
    private val refresh = Runnable { enqueue(refresh = true) }

    fun bind(partition: String, client: ProductClient?) {
        val previous = binding
        val current = client?.takeIf { it.isConnected && it.identity?.partition == partition }
        if (closed || previous?.owner?.id == partition && previous.client === current) return
        val owner = previous?.owner?.takeIf { it.id == partition } ?: Partition(partition)
        binding = Binding(owner, current)
        if (previous?.owner !== owner) {
            restoring = true; recent = emptySet(); sources = emptyMap(); assets = emptyMap(); names = emptyMap()
            observers.replaceAll { _, o -> o.copy(ids = emptySet(), nameIds = emptySet()) }
            notifyObservers()
        }
        handler.removeCallbacks(refresh)
        enqueue(refresh = true)
    }

    fun warmRecent(ids: Set<String>) {
        if (recent == ids) return
        recent = ids; enqueue()
    }

    fun observe(key: Any, ids: Set<String>, nameIds: Set<String> = emptySet(), changed: () -> Unit) {
        val previous = observers[key]
        if (closed || previous?.ids == ids && previous.nameIds == nameIds) return
        observers[key] = Observer(ids, nameIds, changed)
        enqueue()
    }

    fun remove(key: Any) {
        observers.remove(key)
        if (observers.isEmpty()) handler.removeCallbacks(refresh)
    }

    private fun notifyObservers() = observers.values.toList().forEach { it.changed() }

    private fun enqueue(refresh: Boolean = false) {
        val request = binding ?: return
        val wanted = observers.values.flatMapTo(linkedSetOf()) { it.ids } + recent
        val nameIds = observers.values.flatMapTo(linkedSetOf()) { it.nameIds }
        worker.execute {
            if (binding !== request) return@execute
            val owner = request.owner
            if (!owner.restored) {
                val profiles = metadata.read(owner.id, "avatar-directory").orEmpty()
                owner.directory = profiles.mapNotNull { p -> (p.opt("name") as? String)?.let { p.optString("id") to it } }.toMap()
                for (record in metadata.read(owner.id, "avatars").orEmpty()) {
                    if (binding !== request) return@execute
                    if (!schemas.response("buddies.getAvatars", JSONObject().put("items", JSONArray(listOf(record))))) continue
                    owner.records[record.getString("buddyId")] = record
                    prepare(owner, record, null)
                }
                owner.restored = true
            }
            if (refresh) publish(request)
            val client = request.client ?: return@execute
            if (refresh) {
                request.checked.clear()
                if (client.supports("buddies.list")) runCatching { readDirectory(request, client, null) }
            }
            if (client.supports("buddies.getAvatars")) {
                for (batch in ((wanted + request.warm) - request.checked).chunked(100)) {
                    if (binding !== request) return@execute
                    val records = runCatching {
                        client.call("buddies.getAvatars", JSONObject().put("buddyIds", JSONArray(batch))).getJSONArray("items").objects()
                            .also { require(it.size == batch.size && it.map { row -> row.getString("buddyId") }.toSet() == batch.toSet()) }
                    }.getOrNull() ?: continue
                    for (record in records) {
                        if (binding !== request) return@execute
                        val id = record.getString("buddyId")
                        if (!prepare(owner, record, client) || binding !== request) continue
                        request.checked.add(id)
                        owner.records.remove(id); owner.records[id] = record
                    }
                    if (binding !== request) return@execute
                    while (owner.records.size > 1000) owner.records.remove(owner.records.keys.first())
                    publish(request)
                    runCatching { metadata.write(owner.id, "avatars", owner.records.values.toList()) }
                }
            }
            var pages = 0
            while (binding === request && nameIds.any { it !in owner.directory } && owner.directory.size < 1000 && pages++ < 10) {
                val cursor = request.cursor ?: break
                if (runCatching { readDirectory(request, client, cursor) }.isFailure || request.cursor == cursor) break
            }
            handler.post {
                if (binding === request && observers.isNotEmpty() && client.isConnected) {
                    handler.removeCallbacks(this.refresh); handler.postDelayed(this.refresh, 60_000)
                }
            }
        }
    }

    private fun readDirectory(request: Binding, client: ProductClient, cursor: String?) {
        val page = client.call("buddies.list", JSONObject().put("limit", if (cursor == null) 8 else 100).put("cursor", cursor ?: JSONObject.NULL))
        if (binding !== request) return
        val owner = request.owner
        val revision = page.getString("catalogRevision")
        val profiles = page.getJSONArray("items").objects().associate { it.getString("id") to it.getString("name") }
        if (cursor == null) {
            request.warm = setOf(page.getString("defaultBuddyId")) + profiles.keys
            if (request.catalogRevision != revision) owner.directory = emptyMap()
            request.catalogRevision = revision
        } else require(request.catalogRevision == revision)
        owner.directory = owner.directory + profiles
        request.cursor = page.opt("nextCursor") as? String
        publish(request)
        runCatching { metadata.write(owner.id, "avatar-directory", owner.directory.map { (id, name) -> JSONObject().put("id", id).put("name", name) }) }
    }

    private fun JSONArray.objects() = (0 until length()).map { getJSONObject(it) }

    private fun prepare(owner: Partition, record: JSONObject, client: ProductClient?): Boolean {
        val avatar = record.getJSONObject("avatar")
        if (avatar.getString("kind") != "image") return true
        val hash = avatar.getString("sha256")
        if (hash in owner.thumbnails) return true
        val id = record.getString("buddyId")
        return runCatching {
            val bytes = images.read(owner.id, avatar) ?: client?.readAvatar(id, avatar)?.also { images.write(owner.id, avatar, it) } ?: return false
            val image = ReaderAvatarImage.decode("${owner.prefix}$hash.png", bytes) ?: return false
            owner.thumbnails[hash] = image
            if (owner.thumbnails.size > 64) owner.thumbnails.remove(owner.thumbnails.keys.first())
            true
        }.getOrDefault(false)
    }

    private fun publish(request: Binding) {
        val owner = request.owner
        val directory = owner.directory
        val next = mutableMapOf<String, String>()
        val available = mutableMapOf<String, ReaderAvatarImage>()
        for ((id, record) in owner.records) {
            val avatar = record.getJSONObject("avatar")
            when (avatar.getString("kind")) {
                "preset" -> next[id] = "preset:${avatar.getString("preset")}"
                "image" -> owner.thumbnails[avatar.getString("sha256")]?.let { next[id] = it.url; available[it.url] = it }
            }
        }
        handler.post {
            if (binding !== request) return@post
            assets = available
            if (restoring || sources != next || names != directory) {
                restoring = false; sources = next; names = directory; notifyObservers()
            }
        }
    }

    fun asset(uri: Uri) = assets[uri.toString()]?.response()

    fun close() {
        closed = true; binding = null; handler.removeCallbacks(refresh); observers.clear()
        sources = emptyMap(); names = emptyMap(); assets = emptyMap(); worker.shutdownNow()
    }
}
