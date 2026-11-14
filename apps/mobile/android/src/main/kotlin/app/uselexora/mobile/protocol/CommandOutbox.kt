package app.uselexora.mobile.protocol

import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.OutboxItem
import org.json.JSONObject

class CommandOutbox(private val store: LocalStore) {
    fun submit(client: ProductClient, method: String, intent: JSONObject, localEffect: JSONObject? = null): JSONObject {
        val identity = client.identity ?: throw ProtocolFailure("NOT_CONNECTED")
        val envelope = JSONObject().put("commandId", store.newId()).put("dataGeneration", identity.dataGeneration).put("expectedServiceInstanceId", identity.serviceInstanceId).put("intent", intent)
        client.validateRequest(method, envelope)
        return deliver(client, store.queue(identity.partition, method, envelope, localEffect))
    }
    fun retry(client: ProductClient, item: OutboxItem): JSONObject {
        val checked = reconcile(client, item)
        checked.receipt?.let { return it }
        when (CommandRecovery.forItem(checked, client.identity?.serviceInstanceId)) {
            CommandRecovery.RetryOriginal -> Unit
            CommandRecovery.ReviewApproval -> throw ProtocolFailure("REVIEW_REQUIRED")
            CommandRecovery.ReviewTask -> throw ProtocolFailure("SERVICE_INSTANCE_CHANGED")
            else -> throw ProtocolFailure("COMMAND_RESULT_UNKNOWN")
        }
        return deliver(client, checked)
    }
    private fun deliver(client: ProductClient, item: OutboxItem): JSONObject {
        if (client.identity?.partition != item.partition) throw ProtocolFailure("DATA_GENERATION_CHANGED")
        store.mark(item.id, "unknown")
        return try {
            client.call(item.method, item.envelope).getJSONObject("receipt").also { store.resolve(item, it) }
        } catch (error: Exception) { throw ProtocolFailure("COMMAND_RESULT_UNKNOWN", error) }
    }
    fun reconcile(client: ProductClient, item: OutboxItem): OutboxItem {
        val identity = client.identity ?: throw ProtocolFailure("NOT_CONNECTED")
        if (identity.partition != item.partition) throw ProtocolFailure("DATA_GENERATION_CHANGED")
        val result = client.call("commands.get", JSONObject().put("dataGeneration", item.envelope.getString("dataGeneration")).put("commandId", item.id))
        if (result.getString("lookup") == "decided") {
            val receipt = result.getJSONObject("receipt")
            store.resolve(item, receipt)
        } else store.mark(item.id, result.getString("lookup"))
        return store.outbox(identity.partition).first { it.id == item.id }
    }
}
