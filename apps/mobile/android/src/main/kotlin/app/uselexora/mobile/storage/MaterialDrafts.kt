package app.uselexora.mobile.storage

import app.uselexora.mobile.protocol.MobileContentAdapter
import app.uselexora.mobile.protocol.ProtocolFailure
import org.json.JSONArray
import org.json.JSONObject

object MaterialDrafts {
    fun append(store: LocalStore, partition: String, scope: String, id: String, text: String): LocalDraft = synchronized(store) {
        val current = store.draft(partition, scope)
        val value = current?.value?.let { JSONObject(it.toString()) } ?: JSONObject().put("content", MobileContentAdapter.textContent(""))
        val applied = value.optJSONArray("materialImports") ?: JSONArray()
        if ((0 until applied.length()).any { applied.optString(it) == id }) return@synchronized current!!
        val content = value.getJSONObject("content")
        if (!MobileContentAdapter.canEditAsText(content)) throw ProtocolFailure("DRAFT_READ_ONLY")
        if (current != null && store.hasPendingDraftCommand(current)) throw ProtocolFailure("COMMAND_RESULT_UNKNOWN")
        val previous = MobileContentAdapter.text(content)
        val next = listOf(previous, text).filter { it.isNotBlank() }.joinToString("\n\n")
        if (next.length > 262144) throw ProtocolFailure("CONTENT_TOO_LARGE")
        value.put("content", MobileContentAdapter.textContent(next).put("panelResourceIds", content.optJSONArray("panelResourceIds") ?: JSONArray()))
        val ids = (0 until applied.length()).map { applied.getString(it) }.takeLast(63) + id
        value.put("materialImports", JSONArray(ids))
        store.edit(partition, scope, value)
    }
}
