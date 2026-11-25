package app.uselexora.mobile.ui

import android.content.Context
import app.uselexora.mobile.network.MobileFiles
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.storage.LocalFiles
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.TransferStore
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.nio.file.Files
import java.security.DigestInputStream
import java.security.MessageDigest

internal class TaskFileCopies(private val context: Context, private val transfers: TransferStore, private val store: LocalStore) {
    private val files = LocalFiles(context, transfers, store)
    private val exports get() = File(context.filesDir, "exports")
    private inline fun <T> locked(action: () -> T): T = synchronized(TransferStore.fileLock) {
        try { action() }
        catch (error: IOException) { throw ProtocolFailure("LOCAL_STORAGE_FAILED", error) }
        catch (error: SecurityException) { throw ProtocolFailure("LOCAL_STORAGE_FAILED", error) }
    }
    private fun publicId(record: JSONObject): String? = when (record.optString("kind")) {
        "upload" -> (record.opt("attachmentId") as? String)?.takeIf { it.isNotBlank() }?.let { "attachment:$it" }
        "download" -> record.optString("resourceId")
        else -> null
    }
    private fun candidates(partition: String, resource: JSONObject): List<JSONObject> {
        val id = resource.getString("resourceId")
        return transfers.list(partition).filter { it.optString("partition") == partition && publicId(it) == id }
    }
    private fun checkDraft(partition: String, resource: JSONObject, records: List<JSONObject>) {
        if (!resource.has("localInputId")) return
        val input = resource.getString("localInputId")
        val binding = resource.getString("bindingId")
        val draft = store.draft(partition, resource.getString("localScope"))
        val ids = draft?.value?.getJSONObject("content")?.getJSONArray("panelResourceIds")
        if (input.isBlank() || draft?.value?.optString("inputId") != input || ids == null || (0 until ids.length()).none { ids.optString(it) == binding } ||
            records.none { it.optString("kind") == "upload" && it.optString("state") in setOf("ready", "adopted") && it.optString("inputId") == input &&
                it.optString("resourceId") == binding && it.optString("contentVersion") == resource.getString("revision") }) throw ProtocolFailure("SOURCE_CHANGED")
    }
    private fun export(records: List<JSONObject>, resource: JSONObject, retain: Boolean): File? {
        val directory = exports
        if (Files.isSymbolicLink(directory.toPath())) return null
        for (record in records) {
            if (record.optString("kind") != "download" || record.optString("state") != "ready" || record.optBoolean("localCopyRemoved") ||
                record.optString("expectedVersion") != resource.getString("revision")) continue
            if (resource.getString("resourceId").startsWith("attachment:") && record.optString("contentVersion") != resource.getString("revision")) continue
            if (record.has("sourceBindingId") && record.optString("sourceBindingId") != uploadBinding(records, resource)?.optString("resourceId")) continue
            val file = File(record.optString("path"))
            val id = record.optString("id")
            val size = record.optJSONObject("prepared")?.optString("sizeBytes")?.toLongOrNull() ?: continue
            if (!LocalFiles.validId(id) || !file.name.startsWith("$id-") || Files.isSymbolicLink(file.toPath()) || file.canonicalFile.parentFile != directory.canonicalFile ||
                !file.isFile || size !in 0..MobileFiles.MAX_BYTES || size != file.length() || MobileFiles.hash(file) != record.optString("contentVersion")) continue
            if (retain && record.optString("copyPurpose") == "preview") files.retain(file)
            return file.canonicalFile
        }
        return null
    }
    private fun uploadBinding(records: List<JSONObject>, resource: JSONObject): JSONObject? {
        val version = resource.getString("revision")
        return records.singleOrNull { it.optString("kind") == "upload" && it.optString("state") in setOf("ready", "adopted") &&
            it.optString("resourceId").isNotBlank() &&
            it.optString("contentVersion") == version && it.optJSONObject("file")?.optString("sha256") == version &&
            (!resource.has("bindingId") || it.optString("resourceId") == resource.optString("bindingId")) &&
            (if (resource.has("localInputId")) it.optString("inputId") == resource.optString("localInputId") else it.optString("state") == "adopted" || store.uploadSubmitted(it))
        }
    }
    private fun staged(records: List<JSONObject>, resource: JSONObject): Pair<JSONObject, File>? {
        val record = uploadBinding(records, resource)?.takeUnless { it.optBoolean("localCopyRemoved") } ?: return null
        val size = record.getJSONObject("file").optString("sizeBytes").toLongOrNull() ?: return null
        val file = MobileFiles.stagedFile(context, record) ?: return null
        if (size !in 0..MobileFiles.MAX_BYTES || file.length() != size || resource.has("sizeBytes") && resource.optString("sizeBytes").toLongOrNull() != size) return null
        return record to file
    }
    fun find(partition: String, resource: JSONObject, retain: Boolean = false): File? = locked {
        val records = candidates(partition, resource)
        checkDraft(partition, resource, records)
        export(records, resource, retain)
    }
    // Internal decoder only: unlike forAction, this can return a private staging file.
    fun forThumbnail(partition: String, resource: JSONObject): File? = locked {
        val records = candidates(partition, resource)
        checkDraft(partition, resource, records)
        verifiedSource(records, resource)
    }
    private fun verifiedSource(records: List<JSONObject>, resource: JSONObject): File? = export(records, resource, false) ?:
        staged(records, resource)?.second?.takeIf { MobileFiles.hash(it) == resource.getString("revision") }

    fun forAction(partition: String, resource: JSONObject, retain: Boolean = false): File? = locked {
        val records = candidates(partition, resource)
        checkDraft(partition, resource, records)
        export(records, resource, retain)?.let { return@locked it }
        val (upload, source) = staged(records, resource) ?: return@locked null
        val directory = exports
        if (Files.isSymbolicLink(directory.toPath()) || !directory.isDirectory && !directory.mkdir()) throw ProtocolFailure("LOCAL_STORAGE_FAILED")
        val id = store.newId()
        val version = resource.getString("revision")
        val metadata = JSONObject(upload.getJSONObject("file").toString()).put("contentVersion", version)
        val size = metadata.getLong("sizeBytes")
        val partial = File(directory, "$id.part")
        val destination = File(directory, "$id-${LocalFiles.downloadName(metadata.getString("name"))}")
        val record = JSONObject().put("id", id).put("partition", partition).put("kind", "download").put("copyPurpose", if (retain) "retained" else "preview")
            .put("sourceBindingId", upload.getString("resourceId")).put("resourceId", resource.getString("resourceId")).put("expectedVersion", version)
            .put("contentVersion", version).put("prepared", metadata).put("confirmedBytes", size).put("state", "ready").put("path", destination.absolutePath)
        files.reserve(size, record)
        if (destination.exists() || Files.isSymbolicLink(destination.toPath()) || !partial.createNewFile()) throw ProtocolFailure("LOCAL_STORAGE_FAILED")
        try {
            val digest = MessageDigest.getInstance("SHA-256")
            DigestInputStream(source.inputStream(), digest).use { input -> FileOutputStream(partial).use { output ->
                if (input.copyTo(output) != size || MobileFiles.hex(digest.digest()) != version) return@locked null
                output.fd.sync()
            } }
            if (!partial.renameTo(destination)) throw ProtocolFailure("LOCAL_STORAGE_FAILED")
            try { transfers.save(record) } catch (error: Exception) { destination.delete(); throw error }
            destination
        } finally { partial.delete() }
    }
    fun confirmed(partition: String, resources: List<JSONObject>): Set<String> = locked {
        val byId = transfers.list(partition).filter { it.optString("partition") == partition }.groupBy(::publicId)
        resources.mapNotNull { resource ->
            val id = resource.getString("resourceId")
            val records = byId[id] ?: return@mapNotNull null
            runCatching { checkDraft(partition, resource, records); verifiedSource(records, resource) }.getOrNull()?.let { id }
        }.toSet()
    }
}
