package app.uselexora.mobile.protocol

import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.storage.LocalDraft
import app.uselexora.mobile.storage.LocalStore
import org.json.JSONObject

class MobileInputCommands(private val store: LocalStore) {
    fun send(client: ProductClient, snapshot: LocalDraft, targetScope: JSONObject, method: String = "chat.startTurn"): JSONObject =
        CommandReceipt.requireAccepted(submit(client, snapshot, targetScope, method))

    fun submit(client: ProductClient, snapshot: LocalDraft, targetScope: JSONObject, method: String, visibleRunIds: Set<String> = emptySet(), confirmedRepeat: Boolean = false, displayedExecution: JSONObject? = null): JSONObject {
        if (!client.isConnected) throw ProtocolFailure("NOT_CONNECTED")
        if (client.identity?.partition != snapshot.partition) throw ProtocolFailure("DATA_GENERATION_CHANGED")
        if (!client.supports("chat.submitInput")) throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
        if (store.hasPendingDraftCommand(snapshot)) throw ProtocolFailure("COMMAND_RESULT_UNKNOWN")
        val content = snapshot.value.getJSONObject("content")
        if (!MobileContentAdapter.canEditAsText(content)) throw ProtocolFailure("CONTENT_UNSUPPORTED")
        val input = JSONObject().put("inputId", snapshot.value.optString("inputId").takeIf { it.isNotEmpty() } ?: store.inputId(snapshot.partition, snapshot.scope))
            .put("scope", DraftContext.scope(snapshot.value, targetScope)).put("content", JSONObject(content.toString()))
            .put("executionConfig", snapshot.value.optJSONObject("executionConfig") ?: displayedExecution ?: when (targetScope.getString("kind")) {
                "global", "task", "space" -> {
                    NewTaskDefaults.read(client).execution ?: throw ProtocolFailure("PROTOCOL_INCOMPATIBLE")
                }
                else -> ExecutionSettings.defaultConfig()
            })
            .put("modelSelection", TaskModelTarget.inputOverride(targetScope, snapshot.value, store.draft(snapshot.partition, snapshot.scope)?.value))
            .put("participants", snapshot.value.opt("participants") ?: JSONObject.NULL)
        snapshot.value.optString("draftId").takeIf { it.isNotBlank() && content.getJSONArray("panelResourceIds").length() > 0 }?.let { input.put("legacyResourceDraftId", it) }
        val readDelivery: ((JSONObject) -> JSONObject)? = if (client.supports(MobileInputRouting.READ))
            { params -> client.call(MobileInputRouting.READ, params) } else null
        val intent = MobileInputRouting.intent(method, input, visibleRunIds, readDelivery)
        val effect = JSONObject().put("scope", snapshot.scope).put("editSequence", snapshot.editSequence).put("kind", "submit").put("bodySequence", snapshot.bodySequence).put("untilDecided", true)
        if (confirmedRepeat) effect.put("confirmedRepeat", true)
        return CommandOutbox(store).submit(client, "chat.submitInput", intent, effect)
    }
}
