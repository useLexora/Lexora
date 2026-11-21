package app.uselexora.mobile.storage

import app.uselexora.mobile.protocol.MobileContentAdapter
import app.uselexora.mobile.protocol.ProtocolFailure
import org.json.JSONObject

/** A single immutable editor snapshot; attachment ownership stays with the database. */
data class ComposerEdit(val text: String, val model: String?, val execution: String?, val spaceId: String?, val spaceName: String?, val keepSettings: Boolean = false, val startsNextBody: Boolean = false) {
    internal fun applyTo(value: JSONObject, bodyChanged: Boolean, followsTaskModel: Boolean): Boolean {
        if (bodyChanged) {
            val panel = value.optJSONObject("content")?.optJSONArray("panelResourceIds")
            value.put("content", MobileContentAdapter.textContent(text).apply { if (panel != null) put("panelResourceIds", panel) })
        }
        var changed = bodyChanged
        fun set(key: String, next: Any) {
            if (!sameDraftJson(value.opt(key), next)) { value.put(key, next); changed = true }
        }
        set("modelSelection", if (followsTaskModel) JSONObject.NULL else model?.let(::JSONObject) ?: JSONObject.NULL)
        execution?.let { set("executionConfig", JSONObject(it)) }
        set("spaceId", spaceId ?: JSONObject.NULL)
        set("spaceName", spaceName ?: JSONObject.NULL)
        return changed
    }

    fun value(previous: JSONObject? = null): JSONObject {
        val value = previous ?: JSONObject()
        val content = value.optJSONObject("content")
        if (content == null || MobileContentAdapter.canEditAsText(content))
            applyTo(value, content == null || MobileContentAdapter.text(content) != text, value.optBoolean("followsTaskModel"))
        return value
    }
}

class ComposerMemory(private val store: LocalStore, private val transfers: TransferStore) {
    fun save(partition: String, scope: String, edit: ComposerEdit, inputId: String? = null): LocalDraft? = synchronized(store) {
        val db = store.writableDatabase
        db.beginTransaction()
        try {
            // The receipt may already have moved this input to its newly created branch.
            val original = store.draft(partition, scope)
            val previous = if (inputId != null && original?.value?.optString("inputId") != inputId)
                store.draftByInputId(partition, inputId)
                    ?: if (original == null) null else throw ProtocolFailure("DRAFT_CONFLICT")
            else original
            val destination = previous?.scope ?: scope
            val content = previous?.value?.getJSONObject("content")
            if (content != null && !MobileContentAdapter.canEditAsText(content)) throw ProtocolFailure("DRAFT_READ_ONLY")
            val panel = content?.optJSONArray("panelResourceIds")
            val draft = when {
                edit.text.isEmpty() && !edit.keepSettings && (panel == null || panel.length() == 0) &&
                    (previous == null || (!store.hasPendingDraftCommand(previous) && !hasAttachmentOwner(previous))) -> {
                    if (previous != null) db.delete("drafts", "partition=? AND scope=?", arrayOf(partition, destination))
                    null
                }
                else -> {
                    val value = previous?.value ?: JSONObject()
                    val bodyChanged = edit.startsNextBody || content == null || MobileContentAdapter.text(content) != edit.text
                    val changed = edit.applyTo(value, bodyChanged, destination.startsWith("conversation:") && value.optBoolean("followsTaskModel"))
                    if (changed || previous == null) store.writeDraft(partition, destination, previous, value, bodyChanged) else previous
                }
            }
            db.setTransactionSuccessful()
            draft
        } finally { db.endTransaction() }
    }

    fun detach(partition: String, scope: String, inputId: String, resourceId: String) = synchronized(store) {
        val db = store.writableDatabase
        db.beginTransaction()
        try {
            val current = store.draft(partition, scope) ?: throw ProtocolFailure("EMPTY_DRAFT")
            if (inputId.isNotEmpty() && current.value.optString("inputId") != inputId) throw ProtocolFailure("DRAFT_CONFLICT")
            if (store.hasPendingDraftCommand(current)) throw ProtocolFailure("LOCAL_FILE_IN_USE")
            if (!current.removeResource(resourceId)) throw ProtocolFailure("SOURCE_CHANGED")
            val content = current.value.getJSONObject("content")
            if (content.getJSONArray("panelResourceIds").length() == 0 && MobileContentAdapter.canEditAsText(content) &&
                MobileContentAdapter.text(content).isEmpty() && !hasAttachmentOwner(current, resourceId))
                db.delete("drafts", "partition=? AND scope=?", arrayOf(partition, scope))
            else store.writeDraft(partition, scope, current, current.value, bodyChanged = false)
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    private fun hasAttachmentOwner(draft: LocalDraft, removed: String? = null): Boolean = transfers.list(draft.partition).any { record ->
        val inputId = record.optString("inputId")
        val belongs = if (inputId.isNotEmpty()) inputId == draft.value.optString("inputId") else record.optString("scope") == draft.scope
        belongs && when (record.optString("kind")) {
            "capture" -> record.optString("state") == "captured"
            "upload" -> record.optString("state") in setOf("staged", "receiving") ||
                (record.optString("state") == "ready" && record.optString("resourceId") != removed && !store.uploadSubmitted(record))
            else -> false
        }
    }
}
