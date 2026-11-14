package app.uselexora.mobile.protocol

import org.json.JSONObject
import java.net.URLDecoder
import java.net.URLEncoder

data class ConversationTarget(val conversationId: String, val branchId: String) {
    val localKey get() = "conversation:$conversationId:$branchId"
    val topic get() = "conversation:${encode(conversationId)}:${encode(branchId)}"
    fun params() = JSONObject().put("conversationId", conversationId).put("branchId", branchId)
    fun draftScope() = params().put("kind", "conversation_branch")
    fun history(messageId: String, kind: HistorySource.Kind) = HistorySource(this, messageId, kind)
    companion object {
        fun fromTask(task: JSONObject) = ConversationTarget(task.getString("id"), task.getString("activeBranchId"))
        fun fromTarget(value: JSONObject) = ConversationTarget(value.getString("conversationId"), value.getString("branchId"))
        fun fromTopic(topic: String): ConversationTarget? {
            if (topic == "taskIndex") return null
            val parts = topic.split(':')
            if (parts.size != 3 || parts[0] != "conversation") throw ProtocolFailure("DRAFT_CONFLICT")
            return ConversationTarget(decode(parts[1]), decode(parts[2])).also {
                if (it.conversationId.isEmpty() || it.branchId.isEmpty()) throw ProtocolFailure("DRAFT_CONFLICT")
            }
        }
        private fun encode(value: String) = URLEncoder.encode(value, "UTF-8").replace("+", "%20")
            .replace("%21", "!").replace("%27", "'").replace("%28", "(").replace("%29", ")").replace("%7E", "~")
        private fun decode(value: String) = URLDecoder.decode(value.replace("+", "%2B"), "UTF-8")
    }
}

data class HistorySource(val conversation: ConversationTarget, val messageId: String, val kind: Kind) {
    enum class Kind(val key: String, val wire: String, val messageField: String) {
        Edit("message-edit", "message_edit", "userMessageId"),
        Followup("message-followup", "message_followup", "assistantMessageId"),
    }
    val localKey get() = "${kind.key}:${conversation.conversationId}:${conversation.branchId}:$messageId"
    fun draftScope() = conversation.params().put("kind", kind.wire).put(kind.messageField, messageId)
    companion object {
        fun fromScope(value: JSONObject): HistorySource? {
            val kind = Kind.entries.firstOrNull { it.wire == value.optString("kind") } ?: return null
            return HistorySource(ConversationTarget.fromTarget(value), value.getString(kind.messageField), kind)
        }
    }
}
