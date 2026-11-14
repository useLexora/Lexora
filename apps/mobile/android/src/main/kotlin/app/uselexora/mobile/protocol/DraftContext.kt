package app.uselexora.mobile.protocol

import org.json.JSONObject

object DraftContext {
    fun target(localScope: String): JSONObject {
        if (localScope.startsWith("space:")) {
            val id = localScope.substringAfter(':')
            if (id.isBlank() || id != id.trim() || id.length > 256) throw ProtocolFailure("DRAFT_CONFLICT")
            return JSONObject().put("kind", "space").put("spaceId", id)
        }
        val parts = localScope.split(':')
        if (parts.drop(1).any { !Regex("[A-Za-z0-9][\\w-]{0,127}").matches(it) }) throw ProtocolFailure("DRAFT_CONFLICT")
        return when {
            localScope == "global" -> JSONObject().put("kind", "global")
            parts.size == 2 && parts[0] == "draft" -> JSONObject().put("kind", "task").put("draftId", parts[1]).put("spaceId", JSONObject.NULL)
            parts.size == 3 && parts[0] == "conversation" -> ConversationTarget(parts[1], parts[2]).draftScope()
            parts.size == 4 && parts[0] in setOf("message-edit", "message-followup") -> ConversationTarget(parts[1], parts[2]).history(parts[3], if (parts[0] == "message-edit") HistorySource.Kind.Edit else HistorySource.Kind.Followup).draftScope()
            else -> throw ProtocolFailure("DRAFT_CONFLICT")
        }
    }
    fun key(scope: JSONObject): String = when (scope.getString("kind")) {
        "task" -> "draft:${scope.getString("draftId")}"
        "global" -> "global"
        "space" -> "space:${scope.getString("spaceId")}"
        "conversation_branch" -> ConversationTarget.fromTarget(scope).localKey
        "message_edit", "message_followup" -> HistorySource.fromScope(scope)!!.localKey
        else -> throw ProtocolFailure("DRAFT_CONFLICT")
    }.also { target(it) }
    fun conversation(localScope: String): ConversationTarget? = target(localScope).let {
        if (it.has("conversationId")) ConversationTarget.fromTarget(it) else null
    }
    fun spaceId(value: JSONObject?): String? {
        if (value == null) return null
        val source = if (value.has("spaceId")) value else value.optJSONObject("scope") ?: return null
        return source.optString("spaceId").takeUnless { it.isEmpty() || it == "null" }
    }
    fun scope(value: JSONObject, target: JSONObject): JSONObject = JSONObject(target.toString()).apply {
        if (optString("kind") == "task") put("spaceId", spaceId(value) ?: JSONObject.NULL)
    }
}
