package app.uselexora.mobile.storage

import app.uselexora.mobile.protocol.TaskModelTarget
import app.uselexora.mobile.protocol.TaskModelLane
import app.uselexora.mobile.protocol.ConversationTarget
import app.uselexora.mobile.protocol.ProtocolFailure
import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

data class LocalDraft(val partition: String, val scope: String, val editSequence: Long, val value: JSONObject, val confirmedSequence: Long) {
    val dirty: Boolean get() = editSequence > confirmedSequence
    val bodySequence: Long get() = value.optLong("bodySequence", editSequence)

    internal fun removeResource(id: String): Boolean {
        val resources = value.getJSONObject("content").getJSONArray("panelResourceIds")
        val before = resources.length()
        for (i in before - 1 downTo 0) if (resources.getString(i) == id) resources.remove(i)
        return resources.length() != before
    }
}

internal fun sameDraftJson(a: Any?, b: Any?): Boolean = when {
    a === b -> true
    a === null || b === null -> false
    a is JSONObject && b is JSONObject -> a.length() == b.length() && a.keys().asSequence().all { sameDraftJson(a.get(it), b.opt(it)) }
    a is JSONArray && b is JSONArray -> a.length() == b.length() && (0 until a.length()).all { sameDraftJson(a.get(it), b.get(it)) }
    else -> a == b
}

class SubmittedTextReview(val draft: LocalDraft) : Exception()
data class OutboxItem(val id: String, val partition: String, val method: String, val envelope: JSONObject, val state: String, val receipt: JSONObject?, val localEffect: JSONObject? = null) {
    val inputScope: String? get() = localEffect?.takeIf { effect ->
        when (effect.optString("kind")) {
            "submit" -> method == "chat.submitInput"
            "send" -> method.startsWith("chat.")
            "bind" -> method == "composerDrafts.open"
            "save" -> method == "composerDrafts.save"
            "taskModel" -> method == TaskModelTarget.WRITE
            else -> false
        }
    }?.optString("scope")?.takeIf { it.isNotEmpty() }
    val untilDecided get() = method == "chat.submitInput" && inputScope != null && localEffect?.optBoolean("untilDecided") == true
}

class LocalStore(context: Context) : SQLiteOpenHelper(context, "lexora-mobile.db", null, 3) {
    private companion object { const val PENDING = "state NOT IN ('accepted','rejected','not_received','reviewed')" }
    override fun onConfigure(db: SQLiteDatabase) { db.execSQL("PRAGMA synchronous=FULL"); db.setForeignKeyConstraintsEnabled(true) }
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE drafts(partition TEXT NOT NULL,scope TEXT NOT NULL,edit_sequence INTEGER NOT NULL,value TEXT NOT NULL,confirmed_sequence INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(partition,scope))")
        db.execSQL("CREATE TABLE outbox(id TEXT PRIMARY KEY,partition TEXT NOT NULL,method TEXT NOT NULL,envelope TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,local_effect TEXT)")
        createReceiptStorage(db)
    }
    override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) {
        if (old < 2) db.execSQL("ALTER TABLE outbox ADD COLUMN local_effect TEXT")
        if (old < 3) createReceiptStorage(db)
    }
    private fun createReceiptStorage(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE submitted_resources(partition TEXT NOT NULL,input_id TEXT NOT NULL,resource_id TEXT NOT NULL,PRIMARY KEY(partition,input_id,resource_id))")
        db.execSQL("CREATE INDEX pending_outbox ON outbox(partition,method) WHERE $PENDING")
    }
    @Synchronized fun draft(partition: String, scope: String): LocalDraft? = readableDatabase.rawQuery("SELECT edit_sequence,value,confirmed_sequence FROM drafts WHERE partition=? AND scope=?", arrayOf(partition, scope)).use { cursor ->
        if (!cursor.moveToFirst()) null else LocalDraft(partition, scope, cursor.getLong(0), JSONObject(cursor.getString(1)), cursor.getLong(2))
    }
    @Synchronized fun edit(partition: String, scope: String, value: JSONObject): LocalDraft {
        val previous = draft(partition, scope)
        val bodyChanged = previous == null || !sameDraftJson(previous.value.optJSONObject("content")?.opt("body"), value.optJSONObject("content")?.opt("body"))
        return writeDraft(partition, scope, previous, value, bodyChanged)
    }
    // previous and value belong to the same locked read/modify/write operation.
    internal fun writeDraft(partition: String, scope: String, previous: LocalDraft?, value: JSONObject, bodyChanged: Boolean): LocalDraft {
        if (scope.startsWith("conversation:") && previous?.value?.optBoolean("followsTaskModel") == true) TaskModelTarget.followConfirmed(value)
        value.put("inputId", previous?.value?.optString("inputId")?.takeIf { it.isNotEmpty() } ?: value.optString("inputId").takeIf { it.isNotEmpty() } ?: newId())
        val sequence = (previous?.editSequence ?: 0) + 1
        value.put("bodySequence", if (bodyChanged || previous == null) sequence else previous.bodySequence)
        if (!bodyChanged && previous?.value?.optBoolean("reviewSubmittedText") == true) value.put("reviewSubmittedText", true)
        else value.remove("reviewSubmittedText")
        val encoded = value.toString()
        val entry = ContentValues().apply { put("partition", partition); put("scope", scope); put("edit_sequence", sequence); put("value", encoded); put("confirmed_sequence", previous?.confirmedSequence ?: 0) }
        check(writableDatabase.insertWithOnConflict("drafts", null, entry, SQLiteDatabase.CONFLICT_REPLACE) != -1L) { "LOCAL_STORAGE_FAILED" }
        return LocalDraft(partition, scope, sequence, JSONObject(encoded), previous?.confirmedSequence ?: 0)
    }
    @Synchronized fun updateExecutionConfig(partition: String, scope: String, config: JSONObject) {
        val current = draft(partition, scope) ?: return
        if (!sameDraftJson(current.value.opt("executionConfig"), config))
            writeDraft(partition, scope, current, current.value.put("executionConfig", config), bodyChanged = false)
    }
    @Synchronized fun importDraft(partition: String, remote: JSONObject): LocalDraft {
        val db = writableDatabase
        db.beginTransaction()
        try {
            if (!remote.getBoolean("writable")) throw app.uselexora.mobile.protocol.ProtocolFailure("DRAFT_READ_ONLY")
            val scope = app.uselexora.mobile.protocol.DraftContext.key(remote.getJSONObject("scope"))
            val current = draft(partition, scope)
            if (current != null && (current.dirty || hasPendingDraftCommand(current))) throw app.uselexora.mobile.protocol.ProtocolFailure("LOCAL_DRAFT_DIRTY")
            val revision = java.math.BigInteger(app.uselexora.mobile.protocol.ProductProtocol.revision(remote.get("revision")))
            if (current?.value?.optString("draftId") == remote.getString("draftId") && current.value.has("revision") &&
                revision < java.math.BigInteger(current.value.getString("revision"))) throw app.uselexora.mobile.protocol.ProtocolFailure("DRAFT_CONFLICT")
            val value = JSONObject(remote.toString())
            val content = value.getJSONObject("content")
            if (content.optString("kind") == "editable") value.put("content", content.getJSONObject("content"))
            val sequence = (current?.editSequence ?: 0) + 1
            check(writableDatabase.insertWithOnConflict("drafts", null, ContentValues().apply {
                put("partition", partition); put("scope", scope); put("edit_sequence", sequence)
                put("confirmed_sequence", sequence); put("value", value.toString())
            }, SQLiteDatabase.CONFLICT_REPLACE) != -1L) { "LOCAL_STORAGE_FAILED" }
            db.setTransactionSuccessful()
            return LocalDraft(partition, scope, sequence, value, sequence)
        } finally { db.endTransaction() }
    }
    @Synchronized fun bind(partition: String, scope: String, draftId: String, revision: String) {
        val current = draft(partition, scope) ?: return
        val value = JSONObject(current.value.toString()).put("draftId", draftId).put("revision", revision)
        writableDatabase.update("drafts", ContentValues().apply { put("value", value.toString()) }, "partition=? AND scope=?", arrayOf(partition, scope))
    }
    @Synchronized fun retarget(partition: String, source: String, destination: String): Boolean {
        if (source == destination) return true
        val db = writableDatabase
        db.beginTransaction()
        try {
            val current = draft(partition, source) ?: run { db.setTransactionSuccessful(); return false }
            val target = draft(partition, destination)
            if (target?.dirty == true) { db.setTransactionSuccessful(); return false }
            check(db.insertWithOnConflict("drafts", null, ContentValues().apply {
                put("partition", partition); put("scope", destination); put("edit_sequence", current.editSequence)
                put("value", current.value.toString()); put("confirmed_sequence", current.confirmedSequence)
            }, SQLiteDatabase.CONFLICT_REPLACE) != -1L) { "LOCAL_STORAGE_FAILED" }
            db.delete("drafts", "partition=? AND scope=?", arrayOf(partition, source))
            db.setTransactionSuccessful()
            return true
        } finally { db.endTransaction() }
    }
    @Synchronized fun drafts(
        partition: String? = null,
        includeScope: (String, String) -> Boolean = { _, _ -> true },
        limit: Int = Int.MAX_VALUE,
        include: (LocalDraft) -> Boolean = { true },
    ): List<LocalDraft> = readableDatabase.rawQuery(
        "SELECT partition,scope,edit_sequence,value,confirmed_sequence FROM drafts ${if (partition != null) "WHERE partition=?" else ""} ORDER BY rowid DESC",
        partition?.let { arrayOf(it) }).use { cursor ->
        buildList {
            while (size < limit && cursor.moveToNext()) {
                val owner = cursor.getString(0)
                val scope = cursor.getString(1)
                if (!includeScope(owner, scope)) continue
                val draft = LocalDraft(owner, scope, cursor.getLong(2), JSONObject(cursor.getString(3)), cursor.getLong(4))
                if (include(draft)) add(draft)
            }
        }
    }
    @Synchronized fun acknowledge(partition: String, scope: String, submitted: Long, remoteRevision: String, sent: Boolean) {
        val current = draft(partition, scope) ?: return
        require(submitted <= current.editSequence)
        val nextRevision = java.math.BigInteger(app.uselexora.mobile.protocol.ProductProtocol.revision(remoteRevision))
        val previousRevision = current.value.optString("revision")
        if (previousRevision.isNotEmpty() && nextRevision < java.math.BigInteger(previousRevision)) return
        val value = JSONObject(current.value.toString()).put("revision", remoteRevision)
        if (sent && current.editSequence == submitted) value.put("content", app.uselexora.mobile.protocol.MobileContentAdapter.textContent(""))
        writableDatabase.update("drafts", ContentValues().apply {
            put("value", value.toString()); put("confirmed_sequence", maxOf(current.confirmedSequence, submitted))
        }, "partition=? AND scope=?", arrayOf(partition, scope))
    }
    @Synchronized fun queue(partition: String, method: String, envelope: JSONObject, localEffect: JSONObject? = null): OutboxItem {
        val id = envelope.getString("commandId")
        val entry = OutboxItem(id, partition, method, JSONObject(envelope.toString()), "prepared", null, localEffect?.let { JSONObject(it.toString()) })
        val db = writableDatabase
        db.beginTransaction()
        try {
            val intent = envelope.optJSONObject("intent")
            if (method == "chat.submitInput" && localEffect?.optString("kind") == "submit") {
                val current = draft(partition, localEffect.getString("scope")) ?: throw ProtocolFailure("DRAFT_CONFLICT")
                if (entry.untilDecided && intent?.optJSONObject("input")?.optString("inputId") != current.value.optString("inputId")) throw ProtocolFailure("DRAFT_CONFLICT")
                if (localEffect.optBoolean("confirmedRepeat")) {
                    if (!current.value.optBoolean("reviewSubmittedText") || current.editSequence != localEffect.getLong("editSequence")) throw ProtocolFailure("DRAFT_CONFLICT")
                    current.value.remove("reviewSubmittedText")
                    db.update("drafts", ContentValues().apply { put("value", current.value.toString()) },
                        "partition=? AND scope=?", arrayOf(partition, current.scope))
                } else if (current.value.optBoolean("reviewSubmittedText")) throw SubmittedTextReview(current)
                if (hasPendingDraftCommand(current)) throw ProtocolFailure("COMMAND_RESULT_UNKNOWN")
            }
            val lane = intent?.let { TaskModelLane.of(method, it) }
            if (intent != null && lane != null) {
                val methods = if (method == TaskModelTarget.WRITE) "method IN ('conversations.setModelSelection','chat.submitInput')" else "method='conversations.setModelSelection'"
                db.rawQuery("SELECT method,envelope FROM outbox WHERE partition=? AND $PENDING AND $methods", arrayOf(partition)).use { rows ->
                    while (rows.moveToNext()) {
                        val pending = JSONObject(rows.getString(1)).optJSONObject("intent")?.let { TaskModelLane.of(rows.getString(0), it) }
                        if (pending != null && lane.overlaps(pending)) throw ProtocolFailure("COMMAND_RESULT_UNKNOWN")
                    }
                }
                val input = intent.optJSONObject("input")
                val scope = localEffect?.optString("scope")
                if (input != null && !input.isNull("modelSelection") && scope?.startsWith("conversation:") == true &&
                    draft(partition, scope)?.value?.optBoolean("followsTaskModel") == true) throw ProtocolFailure("DRAFT_CONFLICT")
            }
            db.insertOrThrow("outbox", null, ContentValues().apply { put("id", id); put("partition", partition); put("method", method); put("envelope", envelope.toString()); put("state", entry.state); localEffect?.let { put("local_effect", it.toString()) } })
            db.setTransactionSuccessful()
            return entry
        } finally { db.endTransaction() }
    }
    @Synchronized fun mark(id: String, state: String, receipt: JSONObject? = null) {
        require(state in setOf("prepared", "unknown", "pending", "not_found", "accepted", "rejected"))
        writableDatabase.update("outbox", ContentValues().apply { put("state", state); receipt?.let { put("receipt", it.toString()) } }, "id=? AND $PENDING", arrayOf(id))
    }
    @Synchronized fun outbox(partition: String): List<OutboxItem> = readOutbox(partition, "")
    @Synchronized fun pendingOutbox(partition: String): List<OutboxItem> = readOutbox(partition, "AND $PENDING")
    @Synchronized internal fun pendingTransferIds(partition: String): Set<String> = readableDatabase.rawQuery(
        // Releasing a composer command is not an accepted or rejected transfer receipt.
        "SELECT local_effect FROM outbox WHERE partition=? AND state NOT IN ('accepted','rejected') AND local_effect IS NOT NULL", arrayOf(partition)
    ).use { rows ->
        buildSet {
            while (rows.moveToNext()) {
                val id = JSONObject(rows.getString(0)).optString("transferId")
                if (id.isNotEmpty()) add(id)
            }
        }
    }
    @Synchronized fun pendingComposerCommands(partition: String): List<OutboxItem> = pendingOutbox(partition).filter { it.inputScope != null }
    @Synchronized fun releaseComposerCommand(item: OutboxItem, reviewed: Boolean) {
        require(item.inputScope != null)
        val pending = "id=? AND partition=? AND " + if (reviewed) "state='not_found'" else PENDING
        val args = arrayOf(item.id, item.partition)
        if (item.untilDecided) writableDatabase.delete("outbox", pending, args)
        else writableDatabase.update("outbox", ContentValues().apply { put("state", if (reviewed) "reviewed" else "not_received") }, pending, args)
    }
    private fun readOutbox(partition: String, condition: String): List<OutboxItem> = readableDatabase.rawQuery("SELECT id,method,envelope,state,receipt,local_effect FROM outbox WHERE partition=? $condition ORDER BY rowid DESC", arrayOf(partition)).use { cursor ->
        buildList { while (cursor.moveToNext()) add(OutboxItem(cursor.getString(0), partition, cursor.getString(1), JSONObject(cursor.getString(2)), cursor.getString(3), if (cursor.isNull(4)) null else JSONObject(cursor.getString(4)), if (cursor.isNull(5)) null else JSONObject(cursor.getString(5)))) }
    }
    @Synchronized fun hasPendingDraftCommand(draft: LocalDraft): Boolean = pendingOutbox(draft.partition).any { item ->
        item.localEffect?.optString("scope") == draft.scope ||
            (draft.value.optString("draftId").isNotEmpty() && item.envelope.optJSONObject("intent")?.optString("draftId") == draft.value.optString("draftId"))
    }
    @Synchronized fun resolve(item: OutboxItem, receipt: JSONObject) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val unresolved = db.rawQuery("SELECT 1 FROM outbox WHERE id=? AND partition=? AND $PENDING", arrayOf(item.id, item.partition)).use { it.moveToFirst() }
            if (!unresolved) { db.setTransactionSuccessful(); return }
            if (item.method == TaskModelTarget.WRITE && receipt.optString("decision") == "accepted" && item.localEffect?.optString("kind") == "taskModel") {
                val intent = item.envelope.getJSONObject("intent")
                val target = TaskModelTarget(ConversationTarget.fromTarget(intent), intent.getString("actorId"), intent.getString("expectedRevision"))
                target.acceptedRevision(receipt)
                val scope = target.conversation.localKey
                draft(item.partition, scope)?.let { current ->
                    val value = TaskModelTarget.followConfirmed(current.value)
                    db.update("drafts", ContentValues().apply { put("value", value.toString()) }, "partition=? AND scope=?", arrayOf(item.partition, scope))
                }
            }
            if (!item.untilDecided) mark(item.id, receipt.getString("decision"), receipt)
            if (receipt.getString("decision") == "accepted") item.localEffect?.takeIf { it.optString("kind") in setOf("bind", "save", "send", "submit") }?.let { effect ->
                val scope = effect.getString("scope")
                val sequence = effect.getLong("editSequence")
                val result = receipt.getJSONObject("result")
                when (effect.getString("kind")) {
                    "bind" -> bind(item.partition, scope, result.optString("draftId", effect.getString("draftId")), result.getString("revision"))
                    "save" -> acknowledge(item.partition, scope, sequence, result.getString("revision"), false)
                    "submit" -> {
                        val current = draft(item.partition, scope)
                        val submitted = item.envelope.getJSONObject("intent").getJSONObject("input")
                        if (current != null && current.value.optString("inputId") == submitted.optString("inputId")) {
                            val value = JSONObject(current.value.toString())
                            val submittedContent = submitted.getJSONObject("content")
                            if (current.editSequence == sequence) {
                                TaskModelTarget.followConfirmed(value)
                                value.put("content", app.uselexora.mobile.protocol.MobileContentAdapter.textContent(""))
                                value.remove("draftId"); value.remove("revision")
                            } else {
                                val sent = submittedContent.optJSONArray("panelResourceIds") ?: org.json.JSONArray()
                                val ids = (0 until sent.length()).map { sent.getString(it) }.toSet()
                                val panel = value.getJSONObject("content").getJSONArray("panelResourceIds")
                                val remaining = org.json.JSONArray((0 until panel.length()).map { panel.getString(it) }.filterNot { it in ids })
                                if (effect.has("bodySequence") && current.bodySequence == effect.getLong("bodySequence")) {
                                    value.put("content", app.uselexora.mobile.protocol.MobileContentAdapter.textContent(""))
                                } else if (!effect.has("bodySequence") && submittedContent.getJSONArray("body").toString() == value.getJSONObject("content").getJSONArray("body").toString() &&
                                    app.uselexora.mobile.protocol.MobileContentAdapter.text(submittedContent).isNotEmpty()) {
                                    value.put("reviewSubmittedText", true)
                                }
                                value.getJSONObject("content").put("panelResourceIds", remaining)
                            }
                            db.update("drafts", ContentValues().apply { put("value", value.toString()); put("confirmed_sequence", maxOf(current.confirmedSequence, sequence)) }, "partition=? AND scope=?", arrayOf(item.partition, scope))
                            val target = receipt.getJSONObject("target")
                            retarget(item.partition, scope, "conversation:${target.getString("conversationId")}:${target.getString("branchId")}")
                        }
                    }
                    "send" -> {
                        val revision = result.getJSONObject("draftReceipt").getString("committedRevision")
                        acknowledge(item.partition, scope, sequence, revision, true)
                        val target = receipt.getJSONObject("target")
                        retarget(item.partition, scope, "conversation:${target.getString("conversationId")}:${target.getString("branchId")}")
                    }
                }
            }
            if (item.untilDecided) {
                if (receipt.getString("decision") == "accepted") {
                    val input = item.envelope.getJSONObject("intent").getJSONObject("input")
                    val resources = input.getJSONObject("content").getJSONArray("panelResourceIds")
                    for (index in 0 until resources.length()) db.execSQL("INSERT OR IGNORE INTO submitted_resources VALUES(?,?,?)", arrayOf(item.partition, input.getString("inputId"), resources.getString(index)))
                }
                db.delete("outbox", "id=?", arrayOf(item.id))
            }
            if (receipt.getString("decision") == "accepted" && item.method == "uploads.adopt") item.localEffect?.let { effect ->
                val scope = effect.getString("scope")
                val current = draft(item.partition, scope)
                if (current != null && current.value.optString("draftId") == item.envelope.getJSONObject("intent").getString("draftId")) {
                    val value = JSONObject(current.value.toString())
                    val resources = value.getJSONObject("content").getJSONArray("panelResourceIds")
                    val resource = receipt.getJSONObject("result").getString("resourceId")
                    val appended = (0 until resources.length()).none { resources.getString(it) == resource }
                    if (appended) resources.put(resource)
                    if (current.value.optString("revision") == item.envelope.getJSONObject("intent").optString("expectedRevision"))
                        value.put("revision", receipt.getJSONObject("result").getString("revision"))
                    if (appended) edit(item.partition, scope, value)
                    else db.update("drafts", ContentValues().apply { put("value", value.toString()) }, "partition=? AND scope=?", arrayOf(item.partition, scope))
                }
            }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }
    @Synchronized fun attach(partition: String, inputId: String, resourceId: String, replacingResourceId: String? = null) {
        val current = draftByInputId(partition, inputId) ?: throw ProtocolFailure("EMPTY_DRAFT")
        val value = current.value
        val resources = value.getJSONObject("content").getJSONArray("panelResourceIds")
        val previous = (0 until resources.length()).map { resources.getString(it) }
        val next = previous.filterNot { it == replacingResourceId && it != resourceId }.toMutableList()
        if (resourceId !in next) next.add(resourceId)
        if (next != previous) {
            value.getJSONObject("content").put("panelResourceIds", JSONArray(next))
            writeDraft(partition, current.scope, current, value, bodyChanged = false)
        }
    }
    @Synchronized fun detach(partition: String, inputId: String, resourceId: String) {
        val current = draftByInputId(partition, inputId) ?: return
        if (current.removeResource(resourceId)) writeDraft(partition, current.scope, current, current.value, bodyChanged = false)
    }
    internal fun draftByInputId(partition: String, id: String): LocalDraft? = if (id.isEmpty()) null else
        drafts(partition, limit = 1) { it.value.optString("inputId") == id }.firstOrNull()
    @Synchronized fun <T> publishAttachment(partition: String, scope: String, existingId: String?, publish: (String) -> T): T {
        // The transfer is in a separate database. Commit its input identity first, then
        // hold the draft write lock while checking ownership and publishing the transfer.
        val owner = existingId ?: inputId(partition, scope)
        val db = writableDatabase
        db.beginTransaction()
        try {
            if (draft(partition, scope)?.value?.optString("inputId") != owner &&
                draftByInputId(partition, owner) == null) throw ProtocolFailure("DRAFT_CONFLICT")
            val result = publish(owner)
            db.setTransactionSuccessful()
            return result
        } finally { db.endTransaction() }
    }
    @Synchronized fun inputId(partition: String, scope: String): String {
        val current = draft(partition, scope)
        current?.value?.optString("inputId")?.takeIf { it.isNotEmpty() }?.let { return it }
        val value = current?.value ?: JSONObject().put("content", app.uselexora.mobile.protocol.MobileContentAdapter.textContent(""))
        return writeDraft(partition, scope, current, value, bodyChanged = false).value.getString("inputId")
    }
    @Synchronized fun uploadSubmitted(transfer: JSONObject): Boolean {
        val resourceId = transfer.optString("resourceId").takeIf { it.isNotEmpty() } ?: return false
        val owner = transfer.getString("partition")
        if (readableDatabase.rawQuery("SELECT 1 FROM submitted_resources WHERE partition=? AND input_id=? AND resource_id=?", arrayOf(owner, transfer.optString("inputId"), resourceId)).use { it.moveToFirst() }) return true
        return readOutbox(owner, "AND method='chat.submitInput' AND state='accepted'").any { item ->
            val input = item.envelope.optJSONObject("intent")?.optJSONObject("input")
            val resources = input?.optJSONObject("content")?.optJSONArray("panelResourceIds")
            item.method == "chat.submitInput" && item.state == "accepted" && input?.optString("inputId") == transfer.optString("inputId") &&
                resources != null && (0 until resources.length()).any { resources.getString(it) == resourceId }
        }
    }
    fun newId(): String = UUID.randomUUID().toString()
}
