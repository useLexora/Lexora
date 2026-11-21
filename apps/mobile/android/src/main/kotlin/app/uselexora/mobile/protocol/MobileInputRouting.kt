package app.uselexora.mobile.protocol

import org.json.JSONObject

internal object MobileInputRouting {
    const val READ = "chat.getInputDelivery"

    fun intent(method: String, input: JSONObject, visibleRunIds: Set<String>, readDelivery: ((JSONObject) -> JSONObject)?): JSONObject {
        val scope = input.getJSONObject("scope")
        val operation = when (method) {
            "chat.startTurn" -> if (scope.optString("kind") == "message_edit") "edit" else "start"
            "chat.editUserMessage" -> "edit"
            "chat.queue.enqueue" -> "enqueue"
            "chat.executeCommand" -> "command"
            else -> throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
        }
        val intent = JSONObject().put("operation", operation).put("input", input)
        if (operation != "start" || scope.getString("kind") != "conversation_branch") return intent
        if (readDelivery == null) {
            if (visibleRunIds.isNotEmpty()) throw ProtocolFailure("METHOD_NOT_AVAILABLE")
            return intent
        }
        val delivery = readDelivery(ConversationTarget.fromTarget(scope).params())
        // The negotiated schema validates actor/mode/target. Visible IDs are a click-time fence, never an actor lookup.
        when (val target = delivery.get("target")) {
            JSONObject.NULL -> if (visibleRunIds.isNotEmpty()) throw ProtocolFailure("INPUT_DELIVERY_TARGET_UNAVAILABLE")
            is JSONObject -> {
                if (target.getString("runId") !in visibleRunIds) throw ProtocolFailure("INPUT_DELIVERY_TARGET_UNAVAILABLE")
                intent.put("operation", "enqueue")
            }
            else -> throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
        }
        return intent.put("delivery", delivery)
    }

    fun checkDestination(intent: JSONObject, target: JSONObject) {
        val scope = intent.getJSONObject("input").getJSONObject("scope")
        val requiredId = if (intent.getString("operation") == "enqueue") "queueId" else "runId"
        if (listOf(requiredId, "conversationId", "branchId").any { (target.opt(it) as? String).isNullOrBlank() }
            || (requiredId == "runId" && target.has("queueId"))
            || (scope.has("conversationId") && scope.getString("conversationId") != target.getString("conversationId"))
            || (scope.getString("kind") == "conversation_branch" && scope.getString("branchId") != target.getString("branchId")))
            throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
    }
}
