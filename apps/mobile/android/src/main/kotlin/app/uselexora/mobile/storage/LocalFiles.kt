package app.uselexora.mobile.storage

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import android.content.Context
import app.uselexora.mobile.protocol.ProtocolFailure
import org.json.JSONObject
import java.io.File

class LocalFiles(private val context: Context, private val transfers: TransferStore, private val store: LocalStore, private val protectedPaths: () -> Set<String> = { emptySet() }) {
    data class Entry(val record: JSONObject, val file: File, val name: String, val mime: String, val removable: Boolean) {
        val download get() = record.optString("kind") == "download"
        val complete get() = download && record.optString("state") == "ready" && file.name != "${record.getString("id")}.part"
    }
    data class Temporary(val file: File, val bytes: Long, val modifiedAt: Long)
    fun capacity(): FileBudget.Capacity = synchronized(TransferStore.fileLock) { FileBudget(context.filesDir).capacity() }
    fun temporary(): List<Temporary> = synchronized(TransferStore.fileLock) {
        val ids = transfers.all().map { it.getString("id") }.toSet()
        val protected = protectedPaths().map { File(it).canonicalFile }.toSet()
        val cutoff = System.currentTimeMillis() - TEMPORARY_GRACE_MS
        val directories = listOf("staging", "exports", "capture").map { File(context.filesDir, it) to context.filesDir } + (context.cacheDir to context.cacheDir.parentFile!!)
        directories.flatMap { (directory, parent) -> FileBudget.ownedFiles(directory, parent).filter { file ->
            val name = file.name
            val id = TRANSFER_NAME.find(name)?.groupValues?.get(1)
            val recognized = if (directory == context.cacheDir) name.startsWith("preview-") && name.endsWith(".pixels") else when (directory.name) {
                "staging" -> id != null && name in setOf(id, "$id.part")
                "exports" -> id != null && (name == "$id.part" || name.startsWith("$id-"))
                else -> id != null && name == "$id.jpg"
            }
            recognized && id !in ids && file.canonicalFile !in protected && file.lastModified() in 1..cutoff
        }.map { Temporary(it.canonicalFile, it.length(), it.lastModified()) } }
    }
    fun removeTemporary(expected: List<Temporary>): Int = synchronized(TransferStore.fileLock) {
        val current = temporary().associateBy { it.file }
        var removed = 0
        for (item in expected) {
            if (current[item.file] != item) continue
            if (!item.file.delete()) throw ProtocolFailure("LOCAL_STORAGE_FAILED")
            removed++
        }
        removed
    }
    companion object {
        const val TEMPORARY_GRACE_MS = 24L * 60 * 60 * 1000
        private val TRANSFER_NAME = Regex("^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?=$|[.-])")
    }
    fun list(): List<Entry> = synchronized(TransferStore.fileLock) { transfers.all().mapNotNull { entry(it) } }
    fun remove(expected: JSONObject): Unit = synchronized(TransferStore.fileLock) {
        val current = transfers.list(expected.getString("partition")).firstOrNull { it.optString("id") == expected.getString("id") } ?: throw ProtocolFailure("SOURCE_CHANGED")
        if (current.toString() != expected.toString()) throw ProtocolFailure("SOURCE_CHANGED")
        val item = entry(current) ?: throw ProtocolFailure("RESOURCE_UNAVAILABLE")
        if (!item.removable) throw ProtocolFailure("LOCAL_FILE_IN_USE")
        if (!item.file.delete()) throw ProtocolFailure("LOCAL_STORAGE_FAILED")
        current.put("localCopyRemoved", true)
        if (item.download) current.put("state", "cleared").put("confirmedBytes", 0)
        transfers.save(current)
    }
    private fun entry(record: JSONObject): Entry? {
        val kind = record.optString("kind")
        if (kind !in setOf("upload", "download")) return null
        val directory = File(context.filesDir, if (kind == "download") "exports" else "staging").canonicalFile
        val id = record.getString("id")
        val raw = record.optString("path").takeIf { it.isNotEmpty() }
        val file = if (raw != null && File(raw).exists()) File(raw) else if (kind == "download") File(directory, "$id.part") else return null
        val canonical = file.canonicalFile
        if (java.nio.file.Files.isSymbolicLink(file.toPath()) || canonical.parentFile != directory || !canonical.isFile) return null
        if (kind == "upload" && canonical.name != id || kind == "download" && !(canonical.name.startsWith("$id-") || canonical.name == "$id.part")) return null
        val metadata = record.optJSONObject(if (kind == "download") "prepared" else "file") ?: return null
        val pending = store.outbox(record.getString("partition")).any { it.state !in setOf("accepted", "rejected") && it.localEffect?.optString("transferId") == id }
        val completed = if (kind == "download") true else record.optString("state") in setOf("adopted", "cancelled") || store.uploadSubmitted(record)
        return Entry(JSONObject(record.toString()), canonical, metadata.optString("name", mobileText(R.string.file_label)), metadata.optString("mimeType", "application/octet-stream"), completed && !pending && protectedPaths().none { File(it).canonicalFile == canonical })
    }
}
