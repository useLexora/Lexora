package app.uselexora.mobile.session

import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.protocol.DraftContext
import app.uselexora.mobile.protocol.ConversationTarget
import app.uselexora.mobile.protocol.HistorySource
import app.uselexora.mobile.protocol.MobileInputCommands
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.storage.LocalDraft
import app.uselexora.mobile.storage.LocalStore
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Future

class MobileComposerSession(
    private val store: LocalStore,
    private val disk: ExecutorService,
    private val onUi: (() -> Unit) -> Unit,
) {
    data class Scope(val partition: String, val target: String)
    data class Submission(val scope: Scope, val method: String, val conversation: JSONObject, val target: ConversationTarget)
    var scope = Scope("unpaired-local", "global")
        private set
    var pendingWrite: Future<LocalDraft>? = null
        private set
    private var displayed: Scope? = null
    private var revision = 0L
    private var restoreGeneration = 0L
    private var closed = false
    private val submitting = mutableSetOf<Scope>()
    val displayingScope get() = displayed == scope
    val isSubmitting get() = scope in submitting

    fun select(partition: String, target: String) {
        val next = Scope(partition, target)
        if (scope == next) return
        scope = next
        restoreGeneration++
        pendingWrite = null
    }
    fun persist(value: JSONObject, saved: () -> Unit, failed: () -> Unit) {
        val target = scope
        val edit = ++revision
        val snapshot = JSONObject(value.toString())
        pendingWrite = disk.submit<LocalDraft> {
            try {
                val previous = store.draft(target.partition, target.target)
                previous?.value?.optJSONObject("content")?.optJSONArray("panelResourceIds")?.let { snapshot.getJSONObject("content").put("panelResourceIds", it) }
                for (key in listOf("draftId", "revision", "participants", "materialImports")) previous?.value?.opt(key)?.let { snapshot.put(key, it) }
                val draft = store.edit(target.partition, target.target, snapshot)
                onUi { if (!closed && scope == target && revision == edit) saved() }
                draft
            } catch (error: Exception) {
                onUi { if (!closed && scope == target) failed() }
                throw error
            }
        }
    }
    fun <T> restore(read: (LocalDraft?) -> T, ready: (LocalDraft?, T) -> Unit, failed: () -> Unit) {
        val target = scope
        val request = ++restoreGeneration
        val edit = revision
        pendingWrite = null
        disk.execute {
            try {
                val current = store.draft(target.partition, target.target)
                val value = read(current)
                onUi {
                    if (!closed && scope == target && request == restoreGeneration && revision == edit) {
                        displayed = target
                        ready(current, value)
                    }
                }
            } catch (_: Exception) { onUi { if (!closed && scope == target && request == restoreGeneration) failed() } }
        }
    }
    fun submit(client: ProductClient, method: String, extra: JSONObject, work: (() -> Unit) -> Unit,
        accepted: (Submission) -> Unit, settled: () -> Unit) {
        val target = scope
        val pending = pendingWrite
        val captured = if (pending == null) store.draft(target.partition, target.target) else null
        val extraSnapshot = JSONObject(extra.toString())
        if (!submitting.add(target)) return
        work {
            try {
                val draft = pending?.get() ?: captured ?: throw ProtocolFailure("EMPTY_DRAFT")
                if (draft.partition != target.partition || draft.scope != target.target) throw ProtocolFailure("DRAFT_CONFLICT")
                val context = DraftContext.target(target.target)
                val editing = HistorySource.fromScope(context)?.kind == HistorySource.Kind.Edit
                val actualMethod = if (editing) "chat.editUserMessage" else method
                val intent = if (editing) JSONObject().put("conversationId", context.getString("conversationId")).put("userMessageId", context.getString("userMessageId")) else extraSnapshot
                val receipt = MobileInputCommands(store).send(client, draft, context, actualMethod, intent)
                val acceptedTarget = ConversationTarget.fromTarget(receipt.getJSONObject("target"))
                val conversation = client.call("conversations.get", JSONObject().put("conversationId", acceptedTarget.conversationId))
                onUi { if (!closed) accepted(Submission(target, actualMethod, conversation, acceptedTarget)) }
            } finally {
                onUi { submitting.remove(target); if (!closed) settled() }
            }
        }
    }
    fun close() { closed = true; restoreGeneration++ }
}
