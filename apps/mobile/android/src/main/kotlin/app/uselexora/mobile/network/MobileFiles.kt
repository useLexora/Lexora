package app.uselexora.mobile.network

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import app.uselexora.mobile.protocol.CommandOutbox
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.storage.FileBudget
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.PhotoStore
import androidx.core.content.FileProvider
import app.uselexora.mobile.storage.TransferStore
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.security.MessageDigest
import java.util.UUID

class MobileFiles(private val context: Context, private val transfers: TransferStore, private val store: LocalStore, private val connection: MobileConnection) {
    private fun <T> localIO(operation: () -> T): T = try { operation() }
        catch (error: IOException) { throw ProtocolFailure("LOCAL_STORAGE_FAILED", error) }
        catch (error: SecurityException) { throw ProtocolFailure("LOCAL_STORAGE_FAILED", error) }
    private val policy = JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }).getJSONObject("uploadPolicy")
    private fun uploadLimit(mimeType: String): Long {
        fun includes(key: String): Boolean = policy.getJSONArray(key).let { values -> (0 until values.length()).any { values.getString(it) == mimeType } }
        return when {
            mimeType.startsWith("text/") || includes("textMimeTypes") -> policy.getLong("textBytes")
            mimeType == "application/pdf" -> policy.getLong("maxBytes")
            includes("imageMimeTypes") || includes("documentMimeTypes") -> policy.getLong("mediaBytes")
            else -> throw ProtocolFailure("FILE_TYPE_UNSUPPORTED")
        }
    }
    fun stage(uri: Uri, partition: String, scope: String, targetScope: JSONObject): JSONObject = synchronized(TransferStore.fileLock) {
        try { stageLocked(uri, partition, scope, targetScope) }
        catch (error: IOException) { throw ProtocolFailure("LOCAL_FILE_FAILED", error) }
        catch (error: SecurityException) { throw ProtocolFailure("LOCAL_FILE_FAILED", error) }
    }
    fun stageMaterial(uri: Uri, partition: String, scope: String, materialId: String, inputId: String, name: String? = null, mime: String? = null): JSONObject = synchronized(TransferStore.fileLock) {
        transfers.list(partition).firstOrNull { it.optString("sourceMaterialId") == materialId && it.optString("scope") == scope }?.let { return@synchronized it }
        stageLocked(uri, partition, scope, app.uselexora.mobile.protocol.DraftContext.target(scope), materialId = materialId, suppliedName = name, suppliedMime = mime, inputId = inputId)
    }
    private fun stageLocked(uri: Uri, partition: String, scope: String, targetScope: JSONObject, capture: JSONObject? = null, materialId: String? = null, suppliedName: String? = null, suppliedMime: String? = null, inputId: String? = null): JSONObject {
        val id = UUID.randomUUID().toString()
        val directory = File(context.filesDir, "staging").apply { mkdirs() }
        val temporary = File(directory, "$id.part")
        val destination = File(directory, id)
        val name = suppliedName ?: context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor -> if (cursor.moveToFirst()) cursor.getString(0) else null } ?: "attachment"
        val safeName = name.replace(Regex("[\\\\/\\p{Cntrl}]"), "_").take(255).ifBlank { "attachment" }
        val mimeType = suppliedMime ?: context.contentResolver.getType(uri) ?: "application/octet-stream"
        val limit = uploadLimit(mimeType)
        val capacity = FileBudget(context.filesDir).capacity()
        val digest = MessageDigest.getInstance("SHA-256")
        try {
            context.contentResolver.openInputStream(uri).use { input ->
                if (input == null) throw ProtocolFailure("RESOURCE_UNAVAILABLE")
                FileOutputStream(temporary).use { output ->
                    val buffer = ByteArray(65536); var size = 0L
                    while (true) { val read = input.read(buffer); if (read < 0) break; size += read; if (size > limit) throw ProtocolFailure("FILE_TOO_LARGE"); capacity.requireAdditional(size); digest.update(buffer, 0, read); output.write(buffer, 0, read) }
                    output.fd.sync()
                }
            }
            if (!temporary.renameTo(destination)) throw ProtocolFailure("LOCAL_STORAGE_FAILED")
            val value = JSONObject().put("id", id).put("partition", partition).put("scope", scope).put("kind", "upload").put("inputId", inputId ?: store.inputId(partition, scope)).put("targetScope", JSONObject(targetScope.toString())).put("path", destination.absolutePath).put("state", "staged")
                .put("file", JSONObject().put("name", safeName).put("mimeType", mimeType).put("sizeBytes", destination.length()).put("sha256", hex(digest.digest())))
            capture?.let { value.put("sourceCaptureId", it.getString("id")) }
            materialId?.let { value.put("sourceMaterialId", it) }
            transfers.save(value)
            return value
        } catch (error: Exception) { temporary.delete(); if (transfers.list(partition).none { it.optString("id") == id }) destination.delete(); if (error is IOException || error is SecurityException) throw ProtocolFailure("LOCAL_FILE_FAILED", error); throw error }
    }
    fun stageCapture(original: JSONObject): JSONObject = synchronized(TransferStore.fileLock) {
        val photos = PhotoStore(context, transfers)
        val capture = photos.current(original)
        if (capture.optString("state") == "cancelled") throw ProtocolFailure("RESOURCE_UNAVAILABLE")
        val owner = capture.getString("partition")
        val previous = transfers.list(owner).firstOrNull { it.optString("sourceCaptureId") == capture.getString("id") }
        val transfer = previous ?: try {
            stageLocked(FileProvider.getUriForFile(context, "${context.packageName}.files", photos.file(capture)), owner, capture.getString("scope"), capture.getJSONObject("targetScope"), capture)
        } catch (error: IOException) { throw ProtocolFailure("LOCAL_FILE_FAILED", error) }
        catch (error: SecurityException) { throw ProtocolFailure("LOCAL_FILE_FAILED", error) }
        photos.copied(capture, transfer)
        transfer
    }
    fun upload(client: ProductClient, original: JSONObject, target: JSONObject): JSONObject = synchronized(TransferStore.fileLock) { uploadLocked(client, original, target) }
    private fun uploadLocked(client: ProductClient, original: JSONObject, target: JSONObject): JSONObject {
        val identity = client.identity ?: throw ProtocolFailure("NOT_CONNECTED")
        val transfer = JSONObject(original.toString())
        if (transfer.getString("partition") != identity.partition) throw ProtocolFailure("DATA_GENERATION_CHANGED")
        if (store.uploadSubmitted(transfer)) {
            transfer.put("state", "adopted"); transfers.save(transfer)
            return JSONObject().put("decision", "accepted").put("result", JSONObject().put("resourceId", transfer.getString("resourceId")))
        }
        val file = File(transfer.getString("path"))
        val metadata = transfer.getJSONObject("file")
        if (!file.isFile || file.length() != metadata.getLong("sizeBytes") || localIO { hash(file) } != metadata.getString("sha256")) throw ProtocolFailure("SOURCE_CHANGED")
        val localInput = transfer.optString("inputId").takeIf { it.isNotBlank() } ?: target.optString("inputId").takeIf { it.isNotBlank() }
        if (localInput != null && !transfer.has("uploadId")) {
            transfer.put("inputId", localInput); transfer.remove("draftId"); transfer.remove("expectedRevision"); transfers.save(transfer)
        }
        if (localInput == null && !transfer.has("draftId")) { transfer.put("draftId", target.getString("draftId")).put("expectedRevision", target.getString("expectedRevision")); transfers.save(transfer) }
        if (!transfer.has("uploadId")) {
            val created = if (transfer.has("inputId")) command(client, transfer, "uploads.stage", JSONObject().put("inputId", transfer.getString("inputId")).put("file", metadata))
                else command(client, transfer, "uploads.create", JSONObject().put("draftId", transfer.getString("draftId")).put("expectedRevision", transfer.getString("expectedRevision")).put("file", metadata))
            transfer.put("uploadId", created.getJSONObject("result").getString("uploadId")).put("state", "receiving"); transfers.save(transfer)
        }
        val id = transfer.getString("uploadId")
        var state = client.call("uploads.get", JSONObject().put("uploadId", id))
        if (state.getString("uploadId") != id || (if (transfer.has("inputId")) state.optString("inputId") != transfer.getString("inputId") else state.getString("draftId") != transfer.getString("draftId")) || state.getLong("sizeBytes") != metadata.getLong("sizeBytes") || state.getString("sha256") != metadata.getString("sha256")) throw ProtocolFailure("SOURCE_CHANGED")
        if (transfer.has("inputId") && state.getString("state") in setOf("expired", "failed")) {
            val local = store.drafts().firstOrNull { it.partition == identity.partition && store.inputId(it.partition, it.scope) == transfer.getString("inputId") } ?: throw ProtocolFailure("EMPTY_DRAFT")
            if (store.hasPendingDraftCommand(local)) throw ProtocolFailure("COMMAND_RESULT_UNKNOWN")
            transfer.optString("resourceId").takeIf { it.isNotEmpty() }?.let { transfer.put("replacedResourceId", it) }
            transfer.remove("resourceId"); transfer.remove("uploadId")
            transfer.put("uploadAttemptId", store.newId()).put("state", "staged").put("confirmedBytes", 0)
            transfers.save(transfer)
            return uploadLocked(client, transfer, target)
        }
        if (state.getString("state") == "receiving") {
            var confirmed = state.getLong("confirmedBytes")
            if (confirmed !in 0..file.length()) throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
            connection.http(identity) { transport, credential ->
                localIO { RandomAccessFile(file, "r") }.use { input ->
                    localIO { input.seek(confirmed) }
                    while (confirmed < file.length()) {
                        val bytes = ByteArray(minOf(CHUNK_BYTES.toLong(), file.length() - confirmed).toInt()); localIO { input.readFully(bytes) }
                        val headers = mapOf("Content-Type" to "application/octet-stream", "Content-Range" to "bytes $confirmed-${confirmed + bytes.size - 1}/${file.length()}", "X-Content-SHA256" to hash(bytes))
                        transport.request("/v1/uploads/$id", "PUT", bytes, credential, headers).use { response ->
                            val result = JSONObject(response.body?.string() ?: "{}")
                            if (!response.isSuccessful) throw ProtocolFailure(result.optString("error", "UPLOAD_FAILED"))
                            if (result.getString("uploadId") != id || result.getLong("confirmedBytes") != confirmed + bytes.size) throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
                            confirmed = result.getLong("confirmedBytes")
                            transfer.put("confirmedBytes", confirmed); transfers.save(transfer)
                        }
                    }
                }
            }
            command(client, transfer, "uploads.complete", JSONObject().put("uploadId", id))
            state = client.call("uploads.get", JSONObject().put("uploadId", id))
        }
        if (state.getString("state") !in setOf("ready", "adopted")) throw ProtocolFailure("RESOURCE_UNAVAILABLE")
        if (state.getString("state") == "ready") { transfer.put("state", "ready"); transfers.save(transfer) }
        if (transfer.has("inputId")) {
            transfer.put("state", state.getString("state")).put("resourceId", state.getString("resourceId")); transfers.save(transfer)
            if (state.getString("state") == "ready") {
                store.attach(identity.partition, transfer.getString("inputId"), transfer.getString("resourceId"), transfer.optString("replacedResourceId").takeIf { it.isNotEmpty() })
                transfer.remove("replacedResourceId"); transfers.save(transfer)
            }
            return JSONObject().put("decision", "accepted").put("result", JSONObject().put("resourceId", state.getString("resourceId")))
        }
        val adopted = command(client, transfer, "uploads.adopt", JSONObject().put("uploadId", id).put("draftId", transfer.getString("draftId")).put("expectedRevision", transfer.getString("expectedRevision")))
        transfer.put("state", "adopted").put("resourceId", adopted.getJSONObject("result").getString("resourceId")); transfers.save(transfer)
        return adopted
    }
    fun reviewAdoption(client: ProductClient, original: JSONObject): JSONObject = synchronized(TransferStore.fileLock) {
        val transfer = currentTransfer(client, original)
        val attempts = store.outbox(transfer.getString("partition")).filter { it.method == "uploads.adopt" && it.localEffect?.optString("transferId") == transfer.getString("id") }
        val outbox = CommandOutbox(store)
        val decisions = attempts.map { if (it.receipt == null) outbox.reconcile(client, it) else it }
        if (decisions.any { it.state !in setOf("accepted", "rejected") }) throw ProtocolFailure("COMMAND_RESULT_UNKNOWN")
        decisions.firstOrNull { it.state == "accepted" }?.let {
            rememberAdoption(transfer, it.receipt!!)
            throw ProtocolFailure("UPLOAD_ALREADY_ADOPTED")
        }
        val remote = client.call("uploads.get", JSONObject().put("uploadId", transfer.getString("uploadId")))
        if (remote.getString("state") != "ready") throw ProtocolFailure("RESOURCE_UNAVAILABLE")
        val draft = client.callValue("composerDrafts.get", JSONObject().put("draftId", transfer.getString("draftId"))) as? JSONObject ?: throw ProtocolFailure("OBJECT_DELETED")
        if (!draft.optBoolean("writable")) throw ProtocolFailure("DRAFT_CONFLICT")
        draft
    }
    fun adoptReviewed(client: ProductClient, original: JSONObject, reviewed: JSONObject): JSONObject = synchronized(TransferStore.fileLock) {
        val transfer = currentTransfer(client, original)
        if (reviewed.getString("draftId") != transfer.getString("draftId")) throw ProtocolFailure("DRAFT_CONFLICT")
        val current = reviewAdoption(client, transfer)
        if (current.getString("revision") != reviewed.getString("revision")) throw ProtocolFailure("DRAFT_CONFLICT")
        transfer.put("expectedRevision", current.getString("revision")); transfers.save(transfer)
        uploadLocked(client, transfer, JSONObject().put("draftId", transfer.getString("draftId")).put("expectedRevision", current.getString("revision")))
    }
    private fun rememberAdoption(transfer: JSONObject, receipt: JSONObject) {
        transfer.put("state", "adopted").put("resourceId", receipt.getJSONObject("result").getString("resourceId")); transfers.save(transfer)
    }
    private fun currentTransfer(client: ProductClient, original: JSONObject): JSONObject {
        val owner = original.getString("partition")
        if (client.identity?.partition != owner) throw ProtocolFailure("DATA_GENERATION_CHANGED")
        return transfers.list(owner).firstOrNull { it.getString("id") == original.getString("id") } ?: throw ProtocolFailure("RESOURCE_UNAVAILABLE")
    }
    fun cancel(client: ProductClient, transfer: JSONObject): Unit = synchronized(TransferStore.fileLock) { cancelLocked(client, transfer) }
    private fun cancelLocked(client: ProductClient, transfer: JSONObject): Unit {
        if (client.identity?.partition != transfer.getString("partition")) throw ProtocolFailure("DATA_GENERATION_CHANGED")
        val current = currentTransfer(client, transfer)
        if (current.optString("state") == "adopted") throw ProtocolFailure("UPLOAD_ALREADY_ADOPTED")
        val pending = store.outbox(current.getString("partition")).filter { it.localEffect?.optString("transferId") == current.getString("id") && it.localEffect.optString("uploadAttemptId") == current.optString("uploadAttemptId") && it.method != "uploads.cancel" }
        val outbox = CommandOutbox(store)
        for (item in pending) {
            val result = if (item.receipt == null) outbox.reconcile(client, item) else item
            if (result.state !in setOf("accepted", "rejected")) throw ProtocolFailure("COMMAND_RESULT_UNKNOWN")
            if (result.state == "accepted" && item.method == "uploads.adopt") { rememberAdoption(current, result.receipt!!); throw ProtocolFailure("UPLOAD_ALREADY_ADOPTED") }
            if (result.state == "accepted" && item.method in setOf("uploads.create", "uploads.stage")) { current.put("uploadId", result.receipt!!.getJSONObject("result").getString("uploadId")); transfers.save(current) }
        }
        if (current.has("uploadId")) {
            val receipt = command(client, current, "uploads.cancel", JSONObject().put("uploadId", current.getString("uploadId")))
            if (!receipt.getJSONObject("result").getBoolean("cancelled")) {
                current.put("state", "adopted"); transfers.save(current)
                throw ProtocolFailure("UPLOAD_ALREADY_ADOPTED")
            }
        }
        if (current.has("inputId")) for (key in listOf("resourceId", "replacedResourceId")) {
            current.optString(key).takeIf { it.isNotEmpty() }?.let { store.detach(current.getString("partition"), current.getString("inputId"), it) }
        }
        current.put("state", "cancelled"); transfers.save(current)
        val file = File(current.getString("path"))
        if (file.exists() && !file.delete()) throw ProtocolFailure("LOCAL_STORAGE_FAILED")
    }

    private fun command(client: ProductClient, transfer: JSONObject, method: String, intent: JSONObject): JSONObject {
        val outbox = CommandOutbox(store)
        val previous = store.outbox(transfer.getString("partition")).firstOrNull { it.method == method && it.localEffect?.optString("transferId") == transfer.getString("id") && it.localEffect.optString("uploadAttemptId") == transfer.optString("uploadAttemptId") &&
            (method != "uploads.adopt" || it.envelope.getJSONObject("intent").optString("expectedRevision") == intent.getString("expectedRevision")) }
        val receipt = if (previous == null) outbox.submit(client, method, intent, JSONObject().put("kind", "transfer").put("transferId", transfer.getString("id")).put("uploadAttemptId", transfer.optString("uploadAttemptId")).put("scope", transfer.getString("scope"))) else {
            val checked = if (previous.receipt == null) outbox.reconcile(client, previous) else previous
            checked.receipt ?: outbox.retry(client, checked)
        }
        if (receipt.getString("decision") != "accepted") throw ProtocolFailure(receipt.optString("errorCode", "COMMAND_REJECTED"))
        return receipt
    }
    fun download(client: ProductClient, resource: JSONObject): File = synchronized(TransferStore.fileLock) { downloadLocked(client, resource) }
    private fun downloadLocked(client: ProductClient, resource: JSONObject): File {
        val identity = client.identity ?: throw ProtocolFailure("NOT_CONNECTED")
        val existing = transfers.list(identity.partition).firstOrNull { it.optString("kind") == "download" && it.optString("resourceId") == resource.getString("resourceId") && it.optString("expectedVersion") == resource.getString("revision") }
        val reusable = existing?.optJSONObject("prepared")?.takeIf { runCatching { java.time.Instant.parse(it.getString("expiresAt")) > client.serverNow() }.getOrDefault(false) }
        val prepared = reusable ?: client.call("resources.prepare", JSONObject().put("resourceId", resource.getString("resourceId")).put("expectedVersion", resource.getString("revision")))
        val size = prepared.getString("sizeBytes").toLong()
        if (size !in 0..MAX_BYTES) throw ProtocolFailure("FILE_TOO_LARGE")
        val version = prepared.getString("contentVersion")
        val previous = existing?.takeIf { it.optString("contentVersion") == version }
        val id = previous?.getString("id") ?: UUID.randomUUID().toString()
        val directory = File(context.filesDir, "exports").apply { mkdirs() }
        val name = prepared.getString("name").replace(Regex("[\\\\/\\p{Cntrl}]"), "_").take(160).ifBlank { "download" }
        val complete = File(directory, "$id-$name")
        val partial = File(directory, "$id.part")
        val record = previous?.let { JSONObject(it.toString()) } ?: JSONObject().put("id", id).put("partition", identity.partition).put("kind", "download").put("resourceId", resource.getString("resourceId")).put("contentVersion", version).put("confirmedBytes", 0L).put("expectedVersion", resource.getString("revision")).put("prepared", prepared)
        record.put("prepared", prepared)
        if (complete.isFile && complete.length() == size && localIO { hash(complete) } == version) {
            record.put("state", "ready").put("path", complete.absolutePath).put("confirmedBytes", size).remove("localCopyRemoved")
            transfers.save(record)
            return complete
        }
        record.put("state", "receiving")
        transfers.save(record)
        var offset = record.getLong("confirmedBytes")
        if (offset < 0 || offset > partial.length() || offset > size) offset = 0
        connection.http(identity) { transport, credential ->
            localIO { RandomAccessFile(partial, "rw") }.use { output ->
                localIO { output.setLength(offset); output.seek(offset) }
                FileBudget(context.filesDir).capacity().requireAdditional(size - offset)
                while (offset < size) {
                    val end = minOf(size - 1, offset + CHUNK_BYTES - 1)
                    transport.request("/v1/resources/${prepared.getString("downloadId")}", credential = credential, headers = mapOf("If-Match" to "\"$version\"", "Range" to "bytes=$offset-$end")).use { response ->
                        if (response.code != 206 || response.header("ETag") != "\"$version\"" || response.header("Content-Range") != "bytes $offset-$end/$size") throw ProtocolFailure("RESOURCE_UNAVAILABLE")
                        val body = response.body ?: throw ProtocolFailure("RESOURCE_UNAVAILABLE")
                        if (body.contentLength() != end - offset + 1) throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
                        val bytes = body.bytes(); if (bytes.size.toLong() != end - offset + 1) throw ProtocolFailure("RESOURCE_UNAVAILABLE")
                        localIO { output.write(bytes); output.fd.sync() }; offset += bytes.size
                        record.put("confirmedBytes", offset); transfers.save(record)
                    }
                }
                localIO { output.fd.sync() }
            }
        }
        if (localIO { hash(partial) } != version) { record.put("confirmedBytes", 0); transfers.save(record); throw ProtocolFailure("CONTENT_HASH_MISMATCH") }
        if (!partial.renameTo(complete)) throw ProtocolFailure("LOCAL_STORAGE_FAILED")
        record.put("state", "ready").put("path", complete.absolutePath).remove("localCopyRemoved"); transfers.save(record)
        return complete
    }
    companion object {
        const val MAX_BYTES = 64L * 1024 * 1024
        const val CHUNK_BYTES = 1024 * 1024
        fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }
        fun hash(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))
        fun hash(file: File): String { val digest = MessageDigest.getInstance("SHA-256"); file.inputStream().use { input -> val bytes = ByteArray(65536); while (true) { val count = input.read(bytes); if (count < 0) break; digest.update(bytes, 0, count) } }; return hex(digest.digest()) }
    }
}
