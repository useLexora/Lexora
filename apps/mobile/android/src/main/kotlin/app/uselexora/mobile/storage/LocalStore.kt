package app.uselexora.mobile.storage

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject
import java.util.UUID

data class LocalDraft(val partition: String, val scope: String, val editSequence: Long, val value: JSONObject, val confirmedSequence: Long) {
    val dirty: Boolean get() = editSequence > confirmedSequence
}
data class OutboxItem(val id: String, val partition: String, val method: String, val envelope: JSONObject, val state: String, val receipt: JSONObject?, val localEffect: JSONObject? = null)

class LocalStore(context: Context) : SQLiteOpenHelper(context, "lexora-mobile.db", null, 2) {
    override fun onConfigure(db: SQLiteDatabase) { db.execSQL("PRAGMA synchronous=FULL"); db.setForeignKeyConstraintsEnabled(true) }
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE drafts(partition TEXT NOT NULL,scope TEXT NOT NULL,edit_sequence INTEGER NOT NULL,value TEXT NOT NULL,confirmed_sequence INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(partition,scope))")
        db.execSQL("CREATE TABLE outbox(id TEXT PRIMARY KEY,partition TEXT NOT NULL,method TEXT NOT NULL,envelope TEXT NOT NULL,state TEXT NOT NULL,receipt TEXT,local_effect TEXT)")
    }
    override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) { if (old < 2) db.execSQL("ALTER TABLE outbox ADD COLUMN local_effect TEXT") }
    @Synchronized fun draft(partition: String, scope: String): LocalDraft? = readableDatabase.rawQuery("SELECT edit_sequence,value,confirmed_sequence FROM drafts WHERE partition=? AND scope=?", arrayOf(partition, scope)).use { cursor ->
        if (!cursor.moveToFirst()) null else LocalDraft(partition, scope, cursor.getLong(0), JSONObject(cursor.getString(1)), cursor.getLong(2))
    }
    @Synchronized fun edit(partition: String, scope: String, value: JSONObject): LocalDraft {
        val previous = draft(partition, scope)
        value.put("inputId", previous?.value?.optString("inputId")?.takeIf { it.isNotEmpty() } ?: value.optString("inputId").takeIf { it.isNotEmpty() } ?: newId())
        val sequence = (previous?.editSequence ?: 0) + 1
        val entry = ContentValues().apply { put("partition", partition); put("scope", scope); put("edit_sequence", sequence); put("value", value.toString()); put("confirmed_sequence", previous?.confirmedSequence ?: 0) }
        check(writableDatabase.insertWithOnConflict("drafts", null, entry, SQLiteDatabase.CONFLICT_REPLACE) != -1L) { "LOCAL_STORAGE_FAILED" }
        return LocalDraft(partition, scope, sequence, JSONObject(value.toString()), previous?.confirmedSequence ?: 0)
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
    @Synchronized fun drafts(): List<LocalDraft> = readableDatabase.rawQuery("SELECT partition,scope,edit_sequence,value,confirmed_sequence FROM drafts ORDER BY rowid DESC", null).use { cursor ->
        buildList { while (cursor.moveToNext()) add(LocalDraft(cursor.getString(0), cursor.getString(1), cursor.getLong(2), JSONObject(cursor.getString(3)), cursor.getLong(4))) }
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
        writableDatabase.insertOrThrow("outbox", null, ContentValues().apply { put("id", id); put("partition", partition); put("method", method); put("envelope", envelope.toString()); put("state", entry.state); localEffect?.let { put("local_effect", it.toString()) } })
        return entry
    }
    @Synchronized fun mark(id: String, state: String, receipt: JSONObject? = null) {
        require(state in setOf("prepared", "unknown", "pending", "not_found", "accepted", "rejected"))
        writableDatabase.update("outbox", ContentValues().apply { put("state", state); receipt?.let { put("receipt", it.toString()) } }, "id=?", arrayOf(id))
    }
    @Synchronized fun outbox(partition: String): List<OutboxItem> = readableDatabase.rawQuery("SELECT id,method,envelope,state,receipt,local_effect FROM outbox WHERE partition=? ORDER BY rowid DESC", arrayOf(partition)).use { cursor ->
        buildList { while (cursor.moveToNext()) add(OutboxItem(cursor.getString(0), partition, cursor.getString(1), JSONObject(cursor.getString(2)), cursor.getString(3), if (cursor.isNull(4)) null else JSONObject(cursor.getString(4)), if (cursor.isNull(5)) null else JSONObject(cursor.getString(5)))) }
    }
    @Synchronized fun hasPendingDraftCommand(draft: LocalDraft): Boolean = outbox(draft.partition).any { item ->
        item.state !in setOf("accepted", "rejected") && (
            item.localEffect?.optString("scope") == draft.scope ||
            (draft.value.optString("draftId").isNotEmpty() && item.envelope.optJSONObject("intent")?.optString("draftId") == draft.value.optString("draftId"))
        )
    }
    @Synchronized fun resolve(item: OutboxItem, receipt: JSONObject) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            val terminal = db.rawQuery("SELECT state FROM outbox WHERE id=?", arrayOf(item.id)).use { it.moveToFirst() && it.getString(0) in setOf("accepted", "rejected") }
            if (terminal) { db.setTransactionSuccessful(); return }
            mark(item.id, receipt.getString("decision"), receipt)
            if (receipt.getString("decision") == "accepted") item.localEffect?.takeIf { it.optString("kind") in setOf("bind", "save", "send", "submit") }?.let { effect ->
                val scope = effect.getString("scope")
                val sequence = effect.getLong("editSequence")
                val result = receipt.getJSONObject("result")
                when (effect.getString("kind")) {
                    "bind" -> bind(item.partition, scope, result.optString("draftId", effect.getString("draftId")), result.getString("revision"))
                    "save" -> acknowledge(item.partition, scope, sequence, result.getString("revision"), false)
                    "submit" -> {
                        val current = draft(item.partition, scope)
                        if (current != null) {
                            val value = JSONObject(current.value.toString())
                            val submittedContent = item.envelope.getJSONObject("intent").getJSONObject("input").getJSONObject("content")
                            if (current.editSequence == sequence) {
                                value.put("content", app.uselexora.mobile.protocol.MobileContentAdapter.textContent(""))
                                value.remove("draftId"); value.remove("revision")
                            } else {
                                val sent = submittedContent.optJSONArray("panelResourceIds") ?: org.json.JSONArray()
                                val ids = (0 until sent.length()).map { sent.getString(it) }.toSet()
                                val panel = value.getJSONObject("content").getJSONArray("panelResourceIds")
                                value.getJSONObject("content").put("panelResourceIds", org.json.JSONArray((0 until panel.length()).map { panel.getString(it) }.filterNot { it in ids }))
                            }
                            db.update("drafts", ContentValues().apply { put("value", value.toString()); put("confirmed_sequence", maxOf(current.confirmedSequence, sequence)) }, "partition=? AND scope=?", arrayOf(item.partition, scope))
                        }
                        val target = receipt.getJSONObject("target")
                        retarget(item.partition, scope, "conversation:${target.getString("conversationId")}:${target.getString("branchId")}")
                    }
                    "send" -> {
                        val revision = result.getJSONObject("draftReceipt").getString("committedRevision")
                        acknowledge(item.partition, scope, sequence, revision, true)
                        val target = receipt.getJSONObject("target")
                        retarget(item.partition, scope, "conversation:${target.getString("conversationId")}:${target.getString("branchId")}")
                    }
                }
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
        val current = drafts().firstOrNull { it.partition == partition && inputId(it.partition, it.scope) == inputId } ?: throw app.uselexora.mobile.protocol.ProtocolFailure("EMPTY_DRAFT")
        val scope = current.scope
        val value = JSONObject(current.value.toString())
        val resources = value.getJSONObject("content").getJSONArray("panelResourceIds")
        val previous = (0 until resources.length()).map { resources.getString(it) }
        val next = previous.filterNot { it == replacingResourceId }.toMutableList()
        if (resourceId !in next) next.add(resourceId)
        if (next != previous) {
            value.getJSONObject("content").put("panelResourceIds", org.json.JSONArray(next))
            edit(partition, scope, value)
        }
    }
    @Synchronized fun detach(partition: String, inputId: String, resourceId: String) {
        val current = drafts().firstOrNull { it.partition == partition && it.value.optString("inputId") == inputId } ?: return
        val value = JSONObject(current.value.toString())
        val content = value.getJSONObject("content")
        val resources = content.getJSONArray("panelResourceIds")
        content.put("panelResourceIds", org.json.JSONArray((0 until resources.length()).map { resources.getString(it) }.filterNot { it == resourceId }))
        edit(partition, current.scope, value)
    }
    @Synchronized fun inputId(partition: String, scope: String): String {
        val current = draft(partition, scope)
        current?.value?.optString("inputId")?.takeIf { it.isNotEmpty() }?.let { return it }
        return edit(partition, scope, current?.value ?: JSONObject().put("content", app.uselexora.mobile.protocol.MobileContentAdapter.textContent(""))).value.getString("inputId")
    }
    @Synchronized fun uploadSubmitted(transfer: JSONObject): Boolean {
        val resourceId = transfer.optString("resourceId").takeIf { it.isNotEmpty() } ?: return false
        return outbox(transfer.getString("partition")).any { item ->
            val input = item.envelope.optJSONObject("intent")?.optJSONObject("input")
            val resources = input?.optJSONObject("content")?.optJSONArray("panelResourceIds")
            item.method == "chat.submitInput" && item.state == "accepted" && input?.optString("inputId") == transfer.optString("inputId") &&
                resources != null && (0 until resources.length()).any { resources.getString(it) == resourceId }
        }
    }
    fun newId(): String = UUID.randomUUID().toString()
}
