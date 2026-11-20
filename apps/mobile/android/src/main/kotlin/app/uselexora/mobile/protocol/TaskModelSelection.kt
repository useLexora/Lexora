package app.uselexora.mobile.protocol

import org.json.JSONObject

internal data class TaskModelTarget(val conversation: ConversationTarget, val actorId: String, val revision: String) {
    fun params(): JSONObject = conversation.params().put("actorId", actorId)

    fun bind(controls: JSONObject): TaskModelEdit {
        if (!matches(controls) || controls.optString("revision") != revision) throw ProtocolFailure("SOURCE_CHANGED")
        val active = controls.opt("activeRun")
        if (active !is JSONObject && active !== JSONObject.NULL) throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
        return TaskModelEdit(this, (active as? JSONObject)?.toString())
    }

    fun acceptedRevision(receipt: JSONObject): Long {
        CommandReceipt.requireAccepted(receipt)
        if (receipt.optString("method") != WRITE || !matches(receipt.getJSONObject("target"))) throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
        return ProductProtocol.revision(receipt.getJSONObject("result").opt("revision")).toLong().also {
            if (it < revision.toLong()) throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
        }
    }

    private fun matches(value: JSONObject) = value.optString("conversationId") == conversation.conversationId &&
        value.optString("branchId") == conversation.branchId && value.optString("actorId") == actorId

    companion object {
        const val READ = "conversations.getModelControls"
        const val WRITE = "conversations.setModelSelection"

        fun capture(task: JSONObject?, view: ConversationTarget?, scope: String): TaskModelTarget? {
            if (task == null || view == null || task.optString("id") != view.conversationId || scope != view.localKey) return null
            val actor = task.opt("buddyId") as? String ?: return null
            val revision = task.opt("revision") as? String ?: return null
            if (actor.isEmpty()) return null
            return TaskModelTarget(view, actor, ProductProtocol.revision(revision))
        }

        fun followConfirmed(draft: JSONObject) = draft.put("followsTaskModel", true).put("modelSelection", JSONObject.NULL)

        fun inputOverride(scope: JSONObject, draft: JSONObject, latest: JSONObject?): Any =
            if (scope.optString("kind") == "conversation_branch" && latest?.optBoolean("followsTaskModel") == true) JSONObject.NULL
            else draft.opt("modelSelection") ?: JSONObject.NULL
    }
}

internal data class TaskModelLane(val task: String, val actor: String?) {
    fun overlaps(other: TaskModelLane) = task == other.task && (actor == null || other.actor == null || actor == other.actor)

    companion object {
        fun of(method: String, intent: JSONObject): TaskModelLane? {
            val task = when (method) {
                TaskModelTarget.WRITE -> intent.opt("conversationId")
                "chat.submitInput" -> intent.optJSONObject("input")?.optJSONObject("scope")?.opt("conversationId")
                else -> null
            } as? String ?: return null
            val actor = if (method == TaskModelTarget.WRITE) intent.opt("actorId") as? String else intent.optJSONObject("delivery")?.opt("actorId") as? String
            return TaskModelLane(task, actor)
        }
    }
}

internal data class TaskModelEdit(val target: TaskModelTarget, private val activeRun: String?) {
    fun intent(selection: JSONObject): JSONObject = target.params().put("expectedRevision", target.revision)
        .put("expectedActiveRun", activeRun?.let(::JSONObject) ?: JSONObject.NULL).put("modelSelection", JSONObject(selection.toString()))
}
