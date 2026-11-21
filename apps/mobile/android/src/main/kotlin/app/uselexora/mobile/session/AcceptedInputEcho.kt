package app.uselexora.mobile.session

import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.protocol.ConversationTarget
import app.uselexora.mobile.protocol.MobileContentAdapter
import org.json.JSONObject

class AcceptedInputEcho private constructor(val target: ConversationTarget, val runId: String, private val messageId: String?, val row: JSONObject) {
    fun isProjected(messages: List<JSONObject>, runs: List<JSONObject>): Boolean {
        val id = messageId ?: (runs.firstOrNull { it.optString("id") == runId }?.opt("triggeringMessageId") as? String) ?: return false
        return messages.any { it.optString("id") == id }
    }

    companion object {
        fun from(receipt: JSONObject, method: String, content: JSONObject, attachmentNames: Map<String, String> = emptyMap()): AcceptedInputEcho? {
            if (receipt.optString("decision") != "accepted" || method !in setOf("chat.startTurn", "chat.editUserMessage")) return null
            val destination = receipt.getJSONObject("target")
            val runId = destination.opt("runId") as? String ?: return null
            val target = ConversationTarget.fromTarget(destination)
            val messageId = destination.opt("messageId") as? String
            val resources = content.optJSONArray("panelResourceIds")
            val text = buildList {
                MobileContentAdapter.text(content).takeIf { it.isNotBlank() }?.let(::add)
                if (resources != null) for (index in 0 until resources.length()) add(attachmentNames[resources.getString(index)] ?: mobileText(R.string.mobile_attachment))
            }.joinToString("\n")
            val row = target.params().put("id", messageId ?: "accepted:$runId").put("role", "user").put("createdAt", receipt.getString("decidedAt"))
                .put("body", JSONObject().put("kind", "text").put("text", text))
            return AcceptedInputEcho(target, runId, messageId, row)
        }
    }
}
