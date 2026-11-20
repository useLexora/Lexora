package app.uselexora.mobile.storage

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import app.uselexora.mobile.network.MobileFiles
import android.content.Context
import app.uselexora.mobile.protocol.ProtocolFailure
import org.json.JSONObject
import java.io.File

class LocalFiles(private val context: Context, private val transfers: TransferStore, private val store: LocalStore, private val protectedPaths: () -> Set<String> = { emptySet() }) {
    data class Entry(val record: JSONObject, val file: File, val name: String, val mime: String, val removable: Boolean) {
        val previewOnly get() = record.optString("copyPurpose") == "preview" && download
        val download get() = record.optString("kind") == "download"
        val complete get() = download && record.optString("state") == "ready" && file.name != "${record.getString("id")}.part"
    }
    data class Temporary(val file: File, val bytes: Long, val modifiedAt: Long)
    fun capacity(): FileBudget.Capacity = synchronized(TransferStore.fileLock) { FileBudget(context.filesDir).capacity() }
    internal fun reserve(bytes: Long, incoming: JSONObject? = null): FileBudget.Capacity = synchronized(TransferStore.fileLock) {
        if (bytes < 0) throw ProtocolFailure("LOCAL_CACHE_FULL")
        val budget = FileBudget(context.filesDir)
        var capacity = budget.capacity()
        val preview = incoming?.optString("copyPurpose") == "preview"
        if (!preview && bytes in 0..minOf(capacity.remaining, capacity.freeDisk)) return@synchronized capacity
        val exports = File(context.filesDir, "exports")
        val previews = FileBudget.ownedFiles(exports, context.filesDir).asSequence()
            .mapNotNull { TRANSFER_NAME.find(it.name)?.groupValues?.get(1) }.distinct()
            .mapNotNull(transfers::get).filter { it.optString("kind") == "download" && it.optString("copyPurpose") == "preview" }
        val copies = inventory(previews).toList()
        var cachedBytes = copies.sumOf { it.file.length() } + if (preview) bytes else 0
        var count = copies.size + if (preview && copies.none { it.record.getString("id") == incoming?.optString("id") }) 1 else 0
        fun overLimit() = preview && (cachedBytes > PREVIEW_BYTES || count > PREVIEW_COUNT)
        fun fits() = bytes in 0..minOf(capacity.remaining, capacity.freeDisk) && !overLimit()
        if (fits()) return@synchronized capacity
        val candidates = copies.filter { it.removable && it.record.getString("id") != incoming?.optString("id") && it.recoverablePreview() }
            .sortedBy { it.file.lastModified() }
        val possible = candidates.sumOf { it.file.length() }
        if (preview && (cachedBytes - possible > PREVIEW_BYTES || count - candidates.size > PREVIEW_COUNT)) throw ProtocolFailure("LOCAL_PREVIEW_FULL")
        if (bytes > minOf(capacity.remaining, capacity.freeDisk) + possible) capacity.requireAdditional(bytes)
        for (item in candidates) {
            if (fits()) break
            val length = item.file.length()
            if (length == 0L && !(preview && count > PREVIEW_COUNT)) continue
            if (item.complete && MobileFiles.hash(item.file) != item.record.getString("contentVersion")) continue
            try { remove(item.record) } catch (error: ProtocolFailure) {
                if (error.code == "LOCAL_FILE_IN_USE" || error.code == "SOURCE_CHANGED") continue
                throw error
            }
            cachedBytes -= length; count--
            capacity = budget.capacity()
        }
        capacity.requireAdditional(bytes)
        if (overLimit()) throw ProtocolFailure("LOCAL_PREVIEW_FULL")
        capacity
    }
    private fun Entry.recoverablePreview(): Boolean {
        val version = record.optString("contentVersion")
        val prepared = record.getJSONObject("prepared")
        val size = prepared.optString("sizeBytes").toLongOrNull() ?: return false
        val id = record.getString("id")
        if (!TRANSFER_ID.matches(id) || version != prepared.optString("contentVersion") || !SHA256.matches(version) ||
            record.optString("resourceId").isBlank() || record.optString("expectedVersion").isBlank() || size !in 0..PREVIEW_BYTES) return false
        return if (complete) file.length() == size && file.name == "$id-${downloadName(prepared.getString("name"))}"
            else record.optString("state") == "receiving" && file.name == "$id.part" && file.length() <= size
    }
    fun retain(file: File) = retain(context, transfers, file)
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
        internal fun validId(id: String) = TRANSFER_ID.matches(id)
        internal fun retain(context: Context, transfers: TransferStore, file: File): Unit = synchronized(TransferStore.fileLock) {
            val directory = File(context.filesDir, "exports")
            val key = file.canonicalFile
            if (java.nio.file.Files.isSymbolicLink(directory.toPath()) || java.nio.file.Files.isSymbolicLink(file.toPath()) ||
                key.parentFile != directory.canonicalFile || !key.isFile) throw ProtocolFailure("RESOURCE_UNAVAILABLE")
            val id = TRANSFER_NAME.find(key.name)?.groupValues?.get(1) ?: return@synchronized
            val record = transfers.get(id) ?: return@synchronized
            if (record.optString("copyPurpose") == "preview") {
                if (record.optString("kind") != "download" || record.optString("state") != "ready" ||
                    File(record.optString("path")).canonicalFile != key) throw ProtocolFailure("RESOURCE_UNAVAILABLE")
                transfers.save(record.put("copyPurpose", "retained"))
            }
        }
        internal const val PREVIEW_BYTES = 64L * 1024 * 1024
        internal const val PREVIEW_COUNT = 32
        private val TRANSFER_ID = Regex("[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
        private val SHA256 = Regex("[0-9a-f]{64}")
        internal fun downloadName(name: String) = name.replace(Regex("[\\\\/\\p{Cntrl}]"), "_").take(160).ifBlank { "download" }
        const val TEMPORARY_GRACE_MS = 24L * 60 * 60 * 1000
        private val TRANSFER_NAME = Regex("^(${TRANSFER_ID.pattern})(?=$|[.-])")
    }
    fun hasRetainedDownload(): Boolean = synchronized(TransferStore.fileLock) {
        val retained = transfers.all().asSequence().filter { it.optString("kind") == "download" && it.optString("state") == "ready" && it.optString("copyPurpose") != "preview" }
        inventory(retained).any { it.complete }
    }
    fun list(): List<Entry> = synchronized(TransferStore.fileLock) { inventory(transfers.all().asSequence()).toList() }
    private fun inventory(records: Sequence<JSONObject>): Sequence<Entry> {
        val pendingByPartition = mutableMapOf<String, Set<String>>()
        fun pendingIds(partition: String) = pendingByPartition.getOrPut(partition) { store.pendingTransferIds(partition) }
        return records.mapNotNull { entry(it, ::pendingIds) }
    }
    fun remove(expected: JSONObject): Unit = synchronized(TransferStore.fileLock) {
        val current = transfers.get(expected.getString("id")) ?: throw ProtocolFailure("SOURCE_CHANGED")
        if (current.toString() != expected.toString()) throw ProtocolFailure("SOURCE_CHANGED")
        val item = entry(current, store::pendingTransferIds) ?: throw ProtocolFailure("RESOURCE_UNAVAILABLE")
        if (!item.removable) throw ProtocolFailure("LOCAL_FILE_IN_USE")
        PreviewUse.delete(item.file)
        current.put("localCopyRemoved", true)
        if (item.download) current.put("state", "cleared").put("confirmedBytes", 0)
        transfers.save(current)
    }
    private fun entry(record: JSONObject, pendingTransferIds: (String) -> Set<String>): Entry? {
        val kind = record.optString("kind")
        if (kind !in setOf("upload", "download")) return null
        val parent = File(context.filesDir, if (kind == "download") "exports" else "staging")
        if (java.nio.file.Files.isSymbolicLink(parent.toPath()) || parent.canonicalFile.parentFile != context.filesDir.canonicalFile) return null
        val directory = parent.canonicalFile
        val id = record.getString("id")
        if (id.isEmpty() || '/' in id || '\\' in id) return null
        val raw = record.optString("path").takeIf { it.isNotEmpty() }
        val file = if (raw != null && File(raw).exists()) File(raw) else if (kind == "download") File(directory, "$id.part") else return null
        val canonical = file.canonicalFile
        if (java.nio.file.Files.isSymbolicLink(file.toPath()) || canonical.parentFile != directory || !canonical.isFile) return null
        if (kind == "upload" && canonical.name != id || kind == "download" && !(canonical.name.startsWith("$id-") || canonical.name == "$id.part")) return null
        val metadata = record.optJSONObject(if (kind == "download") "prepared" else "file") ?: return null
        val pending = id in pendingTransferIds(record.getString("partition"))
        val completed = if (kind == "download") true else record.optString("state") in setOf("adopted", "cancelled") || store.uploadSubmitted(record)
        return Entry(JSONObject(record.toString()), canonical, metadata.optString("name", mobileText(R.string.file_label)), metadata.optString("mimeType", "application/octet-stream"), completed && !pending && !PreviewUse.held(canonical) && protectedPaths().none { File(it).canonicalFile == canonical })
    }
}
