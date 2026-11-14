package app.uselexora.mobile.storage

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

class AvatarCache(private val directory: File, private val maxBytes: Long = 8L * 1024 * 1024) {
    fun read(partition: String, avatar: JSONObject): ByteArray? = synchronized(LOCK) {
        runCatching {
            val file = file(partition, avatar.getString("sha256"))
            if (!file.isFile || file.length() !in 1..MAX_IMAGE_BYTES || System.currentTimeMillis() - file.lastModified() > MAX_AGE_MS) return null
            val bytes = file.readBytes()
            if (!matches(avatar, bytes)) { file.delete(); return null }
            bytes
        }.getOrNull()
    }

    fun write(partition: String, avatar: JSONObject, bytes: ByteArray) = synchronized(LOCK) {
        require(matches(avatar, bytes))
        directory.mkdirs()
        directory.listFiles()?.filter { it.name.endsWith(".tmp") }?.forEach { it.delete() }
        val target = file(partition, avatar.getString("sha256"))
        val temporary = File(directory, "${target.name}.tmp")
        try {
            temporary.writeBytes(bytes)
            Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            val entries = directory.listFiles()?.filter { it.name.endsWith(".image") }?.sortedWith(compareByDescending<File> { it == target }.thenByDescending { it.lastModified() }).orEmpty()
            var retained = 0L
            for ((index, entry) in entries.withIndex()) {
                retained += entry.length()
                if (retained > maxBytes || index >= 64 || System.currentTimeMillis() - entry.lastModified() > MAX_AGE_MS) entry.delete()
            }
        } finally { temporary.delete() }
    }

    private fun matches(avatar: JSONObject, bytes: ByteArray) = bytes.size.toLong() in 1..MAX_IMAGE_BYTES &&
        bytes.size == avatar.optInt("sizeBytes") && avatar.optString("mimeType") in setOf("image/png", "image/jpeg", "image/webp") && hash(bytes) == avatar.optString("sha256")

    private fun file(partition: String, sha256: String): File {
        require(sha256.matches(Regex("[a-f0-9]{64}")))
        return File(directory, hash(JSONArray(listOf(partition, sha256)).toString().toByteArray()) + ".image")
    }

    companion object {
        private val LOCK = Any()
        private const val MAX_IMAGE_BYTES = 2L * 1024 * 1024
        private const val MAX_AGE_MS = 7L * 24 * 60 * 60 * 1000
        fun hash(bytes: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
