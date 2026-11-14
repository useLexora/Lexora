package app.uselexora.mobile.protocol

import app.uselexora.mobile.protocol.MobileContentAdapter
import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.storage.LocalDraft
import app.uselexora.mobile.storage.LocalStore
import org.json.JSONObject

class LegacyDraftFixture(private val store: LocalStore) {
    fun save(client: ProductClient, snapshot: LocalDraft, requestedScope: JSONObject): JSONObject {
        if (client.identity?.partition != snapshot.partition) throw ProtocolFailure("DATA_GENERATION_CHANGED")
        if (!MobileContentAdapter.canEditAsText(snapshot.value.getJSONObject("content"))) throw ProtocolFailure("CONTENT_UNSUPPORTED")
        if (store.hasPendingDraftCommand(snapshot)) throw ProtocolFailure("COMMAND_RESULT_UNKNOWN")
        val targetScope = DraftContext.scope(snapshot.value, requestedScope)
        val outbox = CommandOutbox(store)
        val found = client.call("composerDrafts.find", JSONObject().put("scope", targetScope))
        var remote = found.optJSONObject("draft")
        var expectedRevision = snapshot.value.optString("revision").takeIf { it.isNotEmpty() }
        if (remote == null) {
            val id = if (targetScope.optString("kind") == "task") targetScope.getString("draftId") else store.newId()
            val opened = outbox.submit(client, "composerDrafts.open", JSONObject().put("draftId", id).put("scope", targetScope)
                .put("initialContent", snapshot.value.getJSONObject("content")).put("initialExecutionConfig", execution(snapshot))
                .put("initialModelSelection", snapshot.value.opt("modelSelection") ?: JSONObject.NULL).put("initialParticipants", snapshot.value.opt("participants") ?: JSONObject.NULL)
                .put("expectedSlotRevision", found.getString("slotRevision")), effect(snapshot, "bind").put("draftId", id))
            accepted(opened)
            expectedRevision = opened.getJSONObject("result").getString("revision")
            remote = client.call("composerDrafts.get", JSONObject().put("draftId", opened.getJSONObject("result").optString("draftId", id)))
        }
        if (!remote.optBoolean("writable")) throw ProtocolFailure("DRAFT_READ_ONLY")
        val remoteContent = remote.getJSONObject("content")
        if (!MobileContentAdapter.canEditAsText(remoteContent)) throw ProtocolFailure("CONTENT_UNSUPPORTED")
        if (expectedRevision == null || expectedRevision != remote.getString("revision")) throw ProtocolFailure("DRAFT_CONFLICT")
        store.bind(snapshot.partition, snapshot.scope, remote.getString("draftId"), remote.getString("revision"))
        val saveIntent = JSONObject().put("draftId", remote.getString("draftId"))
            .put("expectedRevision", remote.getString("revision")).put("content", snapshot.value.getJSONObject("content"))
            .put("executionConfig", execution(snapshot)).put("modelSelection", snapshot.value.opt("modelSelection") ?: JSONObject.NULL).put("participants", snapshot.value.opt("participants") ?: remote.opt("participants") ?: JSONObject.NULL)
        if (remote.getJSONObject("scope").optString("kind") == "task") saveIntent.put("spaceId", DraftContext.spaceId(snapshot.value) ?: JSONObject.NULL)
        val saved = outbox.submit(client, "composerDrafts.save", saveIntent, effect(snapshot, "save"))
        accepted(saved)
        return JSONObject().put("draftId", remote.getString("draftId")).put("expectedRevision", saved.getJSONObject("result").getString("revision"))
    }
    fun send(client: ProductClient, snapshot: LocalDraft, targetScope: JSONObject, method: String = "chat.startTurn", extra: JSONObject = JSONObject()): JSONObject {
        val intent = save(client, snapshot, targetScope)
        for (key in extra.keys()) intent.put(key, extra.get(key))
        return CommandOutbox(store).submit(client, method, intent, effect(snapshot, "send")).also { accepted(it) }
    }
    private fun execution(snapshot: LocalDraft) = ExecutionSettings.resolve(snapshot.value, null)
    private fun effect(snapshot: LocalDraft, kind: String) = JSONObject().put("scope", snapshot.scope).put("editSequence", snapshot.editSequence).put("kind", kind)
    private fun accepted(receipt: JSONObject) { if (receipt.optString("decision") != "accepted") throw ProtocolFailure(receipt.optString("errorCode", "COMMAND_REJECTED")) }
}
