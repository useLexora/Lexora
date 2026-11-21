package app.uselexora.mobile.storage

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

class ReadCache(private val directory: File, private val maxBytes: Long = 32L * 1024 * 1024) {
    @Synchronized fun read(partition: String, key: String): List<JSONObject>? = runCatching {
        val file = file(partition, key)
        if (!file.isFile || file.length() > ENTRY_BYTES || System.currentTimeMillis() - file.lastModified() > MAX_AGE_MS) return null
        val value = JSONObject(file.readText())
        if (value.optInt("version") != 1 || value.optString("partition") != partition || value.optString("key") != key) return null
        val items = value.getJSONArray("items")
        if (items.length() > MAX_ITEMS) return null
        (0 until items.length()).map { items.getJSONObject(it) }
    }.getOrNull()

    fun write(partition: String, key: String, items: List<JSONObject>) { synchronized(WRITE_LOCK) {
        val snapshot = JSONObject().put("version", 1).put("partition", partition).put("key", key)
        val limit = minOf(ENTRY_BYTES.toLong(), maxBytes)
        val data = if (items.size <= MAX_ITEMS) {
            snapshot.put("items", JSONArray(items)).toString().toByteArray().takeIf { it.size <= limit }
        } else null
        val bytes = data ?: run {
            if (!key.startsWith("conversation:") || items.any { it.optString("entity") == "historyWindow" }) return
            val envelopeBytes = snapshot.put("items", JSONArray()).toString().toByteArray().size
            val recent = recentMessages(items, limit - envelopeBytes)
            if (recent.isEmpty()) return
            snapshot.put("items", JSONArray(recent)).toString().toByteArray()
        }
        directory.mkdirs()
        directory.listFiles()?.filter { it.name.endsWith(".tmp") }?.forEach { it.delete() }
        val target = file(partition, key)
        val temporary = File(directory, "${target.name}.tmp")
        try {
            temporary.writeBytes(bytes)
            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            val entries = directory.listFiles()?.filter { it.name.endsWith(".json") }?.sortedWith(compareByDescending<File> { it == target }.thenByDescending { it.lastModified() }).orEmpty()
            var retained = 0L
            for ((index, entry) in entries.withIndex()) {
                retained += entry.length()
                if (retained > maxBytes || index >= 32 || System.currentTimeMillis() - entry.lastModified() > MAX_AGE_MS) entry.delete()
            }
        } finally { temporary.delete() }
    } }

    private fun recentMessages(items: List<JSONObject>, budget: Long): List<JSONObject> {
        val newestFirst = items.sortedWith(compareByDescending<JSONObject> { it.optJSONObject("value")?.optString("createdAt") }
            .thenByDescending { it.optJSONObject("value")?.optString("id") })
        val retained = mutableListOf<JSONObject>()
        var remaining = budget
        for (item in newestFirst.take(MAX_ITEMS)) {
            val bytes = item.toString().toByteArray().size + if (retained.isEmpty()) 0 else 1
            if (bytes > remaining) break
            retained.add(item)
            remaining -= bytes
        }
        return retained.asReversed()
    }

    private fun file(partition: String, key: String): File {
        val digest = MessageDigest.getInstance("SHA-256").digest(JSONArray(listOf(partition, key)).toString().toByteArray())
        return File(directory, digest.joinToString("") { "%02x".format(it) } + ".json")
    }
    companion object { private val WRITE_LOCK = Any(); private const val MAX_ITEMS = 10_000; private const val ENTRY_BYTES = 8 * 1024 * 1024; private const val MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000 }
}
