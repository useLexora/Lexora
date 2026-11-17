package app.uselexora.mobile.ui

import app.uselexora.mobile.protocol.ConversationTarget
import app.uselexora.mobile.protocol.DraftContext
import app.uselexora.mobile.storage.OutboxItem
import org.json.JSONObject

internal object CommandHistoryTarget {
    data class Target(val conversationId: String, val branchId: String?)
    private fun JSONObject.id(key: String) = optString(key).takeUnless { it.isBlank() || it == "null" }
    fun originalScope(item: OutboxItem): String? = item.localEffect?.id("scope")
    fun target(item: OutboxItem): Target? {
        fun from(value: JSONObject?): Target? = value?.id("conversationId")?.let { Target(it, value.id("branchId")) }
        from(item.receipt?.optJSONObject("target"))?.let { return it }
        val intent = item.envelope.optJSONObject("intent")
        from(intent?.optJSONObject("input")?.optJSONObject("scope"))?.let { return it }
        from(intent?.optJSONObject("scope"))?.let { return it }
        from(intent)?.let { return it }
        val source: ConversationTarget? = originalScope(item)?.let { runCatching { DraftContext.conversation(it) }.getOrNull() }
        return source?.let { Target(it.conversationId, it.branchId) }
    }
}
