package app.uselexora.mobile.protocol

import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.storage.LocalDraft
import app.uselexora.mobile.storage.LocalStore
import org.json.JSONObject

class MobileInputCommands(private val store: LocalStore) {
    fun send(client: ProductClient, snapshot: LocalDraft, targetScope: JSONObject, method: String = "chat.startTurn", extra: JSONObject = JSONObject()): JSONObject {
        if (client.identity?.partition != snapshot.partition) throw ProtocolFailure("DATA_GENERATION_CHANGED")
        if (!client.supports("chat.submitInput")) throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
        val content = snapshot.value.getJSONObject("content")
        if (!MobileContentAdapter.canEditAsText(content)) throw ProtocolFailure("CONTENT_UNSUPPORTED")
        if (store.hasPendingDraftCommand(snapshot)) throw ProtocolFailure("COMMAND_RESULT_UNKNOWN")
        val input = JSONObject().put("inputId", snapshot.value.optString("inputId").takeIf { it.isNotEmpty() } ?: store.inputId(snapshot.partition, snapshot.scope))
            .put("scope", DraftContext.scope(snapshot.value, targetScope)).put("content", JSONObject(content.toString()))
            .put("executionConfig", ExecutionSettings.resolve(snapshot.value, null))
            .put("modelSelection", snapshot.value.opt("modelSelection") ?: JSONObject.NULL)
            .put("participants", snapshot.value.opt("participants") ?: JSONObject.NULL)
        snapshot.value.optString("draftId").takeIf { it.isNotBlank() && content.getJSONArray("panelResourceIds").length() > 0 }?.let { input.put("legacyResourceDraftId", it) }
        val operation = when (method) {
            "chat.startTurn" -> "start"
            "chat.editUserMessage" -> "edit"
            "chat.queue.enqueue" -> "enqueue"
            "chat.executeCommand" -> "command"
            else -> throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
        }
        val intent = JSONObject().put("operation", operation).put("input", input)
        for (key in listOf("buddyId", "delivery")) if (extra.has(key)) intent.put(key, extra.get(key))
        val effect = JSONObject().put("scope", snapshot.scope).put("editSequence", snapshot.editSequence).put("kind", "submit")
        val receipt = CommandOutbox(store).submit(client, "chat.submitInput", intent, effect)
        return CommandReceipt.requireAccepted(receipt)
    }
}
