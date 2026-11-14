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
        if (items.length() > 10000) return null
        (0 until items.length()).map { items.getJSONObject(it) }
    }.getOrNull()

    fun write(partition: String, key: String, items: List<JSONObject>) { synchronized(WRITE_LOCK) {
        if (items.size > 10000) return
        val data = JSONObject().put("version", 1).put("partition", partition).put("key", key).put("items", JSONArray(items)).toString().toByteArray()
        if (data.size > ENTRY_BYTES || data.size > maxBytes) return
        directory.mkdirs()
        directory.listFiles()?.filter { it.name.endsWith(".tmp") }?.forEach { it.delete() }
        val target = file(partition, key)
        val temporary = File(directory, "${target.name}.tmp")
        try {
            temporary.writeBytes(data)
            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            val entries = directory.listFiles()?.filter { it.name.endsWith(".json") }?.sortedWith(compareByDescending<File> { it == target }.thenByDescending { it.lastModified() }).orEmpty()
            var retained = 0L
            for ((index, entry) in entries.withIndex()) {
                retained += entry.length()
                if (retained > maxBytes || index >= 32 || System.currentTimeMillis() - entry.lastModified() > MAX_AGE_MS) entry.delete()
            }
        } finally { temporary.delete() }
    } }

    private fun file(partition: String, key: String): File {
        val digest = MessageDigest.getInstance("SHA-256").digest(JSONArray(listOf(partition, key)).toString().toByteArray())
        return File(directory, digest.joinToString("") { "%02x".format(it) } + ".json")
    }
    companion object { private val WRITE_LOCK = Any(); private const val ENTRY_BYTES = 8 * 1024 * 1024; private const val MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000 }
}
