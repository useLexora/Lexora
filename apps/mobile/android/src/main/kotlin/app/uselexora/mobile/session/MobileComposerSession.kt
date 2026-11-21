package app.uselexora.mobile.session

import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.protocol.CommandReceipt
import app.uselexora.mobile.protocol.DraftContext
import app.uselexora.mobile.protocol.ConversationTarget
import app.uselexora.mobile.protocol.HistorySource
import app.uselexora.mobile.protocol.MobileInputCommands
import app.uselexora.mobile.protocol.ProtocolFailure
import android.os.Handler
import android.os.SystemClock
import app.uselexora.mobile.storage.ComposerEdit
import app.uselexora.mobile.storage.ComposerMemory
import app.uselexora.mobile.storage.LocalDraft
import app.uselexora.mobile.storage.LocalStore
import org.json.JSONObject
import java.util.concurrent.ExecutorService
import java.util.concurrent.Future

class MobileComposerSession(
    private val store: LocalStore,
    private val memory: ComposerMemory,
    private val disk: ExecutorService,
    private val handler: Handler,
    private val onUi: (() -> Unit) -> Unit,
) {
    data class Scope(val partition: String, val target: String)
    data class Submission(val scope: Scope, val target: ConversationTarget, val echo: AcceptedInputEcho?, val inputUnchanged: Boolean)
    var scope = Scope("unpaired-local", "global")
        private set
    private var pendingWrite: Future<LocalDraft?>? = null
    private var buffered: (() -> Unit)? = null
    private var firstEditAt = 0L
    private val saveLatest = Runnable { flush() }
    private data class Unwritten(val inputId: String?, val edit: ComposerEdit)
    private companion object { val unwritten = java.util.concurrent.ConcurrentHashMap<Scope, Unwritten>() }
    private class InputOwner(var id: String? = null)
    private var owner = InputOwner()
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
        flush()
        scope = next
        displayed = null
        owner = InputOwner()
        restoreGeneration++
        pendingWrite = null
    }
    fun persist(snapshot: () -> ComposerEdit, saved: () -> Unit, failed: () -> Unit) {
        val target = scope
        val edit = ++revision
        val editing = owner
        val now = SystemClock.uptimeMillis()
        if (buffered == null) firstEditAt = now
        buffered = {
            val value = snapshot()
            pendingWrite = disk.submit<LocalDraft?> {
                try {
                    val draft = memory.save(target.partition, target.target, value, editing.id)
                    unwritten.remove(target)
                    editing.id = draft?.value?.optString("inputId")?.takeIf { it.isNotEmpty() }
                    onUi { if (!closed && scope == target && revision == edit) saved() }
                    draft
                } catch (error: Exception) {
                    unwritten[target] = Unwritten(editing.id, value)
                    onUi { if (!closed && scope == target && revision == edit) failed() }
                    throw error
                }
            }
        }
        handler.removeCallbacks(saveLatest)
        handler.postAtTime(saveLatest, minOf(now + 400, firstEditAt + 2_000))
    }
    fun flush(): Future<LocalDraft?>? {
        buffered?.let { write -> handler.removeCallbacks(saveLatest); buffered = null; write() }
        return pendingWrite
    }
    fun <T> restore(read: (LocalDraft?) -> T, ready: (LocalDraft?, T) -> Unit, failed: () -> Unit) {
        val target = scope
        val request = ++restoreGeneration
        val edit = revision
        flush()
        disk.execute {
            try {
                val unsaved = unwritten[target]
                var retryFailed = false
                val current = if (unsaved == null) store.draft(target.partition, target.target) else try {
                    memory.save(target.partition, target.target, unsaved.edit, unsaved.inputId).also { unwritten.remove(target, unsaved) }
                } catch (_: Exception) {
                    retryFailed = true
                    val base = runCatching { store.draft(target.partition, target.target)?.value }.getOrNull()
                        ?.takeIf { unsaved.inputId != null && it.optString("inputId") == unsaved.inputId }
                    val value = unsaved.edit.value(base)
                    unsaved.inputId?.let { value.put("inputId", it) }
                    LocalDraft(target.partition, target.target, 0, value, 0)
                }
                val value = read(current)
                onUi {
                    if (!closed && scope == target && request == restoreGeneration && revision == edit) {
                        if (!retryFailed) pendingWrite = null
                        displayed = target
                        owner = InputOwner(current?.value?.optString("inputId")?.takeIf { it.isNotEmpty() })
                        ready(current, value)
                        if (retryFailed) failed()
                    }
                }
            } catch (_: Exception) { onUi { if (!closed && scope == target && request == restoreGeneration) failed() } }
        }
    }
    fun submit(client: ProductClient, method: String, extra: JSONObject, execution: JSONObject, work: (() -> Unit) -> Unit, reviewed: LocalDraft? = null,
        attachmentNames: Map<String, String> = emptyMap(), accepted: (Submission) -> Unit, failed: (MobileOperationFailure) -> Unit, settled: () -> Unit) {
        val target = scope
        if (!submitting.add(target)) return
        val submittedRevision = revision
        val pending = flush()
        val editingOwner = owner
        val captured = disk.submit<LocalDraft?> {
            pending?.get()
            if (unwritten.containsKey(target)) throw ProtocolFailure("LOCAL_STORAGE_FAILED")
            synchronized(store) {
                var draft = store.draft(target.partition, target.target)
                if (draft != null && draft.value.optString("inputId").isEmpty()) {
                    store.inputId(target.partition, target.target)
                    draft = store.draft(target.partition, target.target)
                }
                editingOwner.id = draft?.value?.optString("inputId")
                draft
            }
        }
        val extraSnapshot = JSONObject(extra.toString())
        work {
            try {
                val latest = captured.get() ?: throw ProtocolFailure("EMPTY_DRAFT")
                val draft = reviewed ?: latest
                if (draft.partition != target.partition || draft.scope != target.target) throw ProtocolFailure("DRAFT_CONFLICT")
                val context = DraftContext.target(target.target)
                val editing = HistorySource.fromScope(context)?.kind == HistorySource.Kind.Edit
                val actualMethod = if (editing) "chat.editUserMessage" else method
                val intent = if (editing) JSONObject().put("conversationId", context.getString("conversationId")).put("userMessageId", context.getString("userMessageId")) else extraSnapshot
                val receipt = CommandReceipt.requireAccepted(
                    MobileInputCommands(store).submit(client, draft, context, actualMethod, intent, confirmedRepeat = reviewed != null, displayedExecution = execution))
                val acceptedTarget = ConversationTarget.fromTarget(receipt.getJSONObject("target"))
                val echo = AcceptedInputEcho.from(receipt, actualMethod, draft.value.getJSONObject("content"), attachmentNames)
                onUi { if (!closed) accepted(Submission(target, acceptedTarget, echo, scope == target && revision == submittedRevision && draft.editSequence == latest.editSequence)) }
            } catch (error: Exception) {
                onUi { if (!closed && scope == target) failed(MobileOperationFailure.from(error)) }
            } finally {
                onUi { submitting.remove(target); if (!closed) settled() }
            }
        }
    }
    fun close() { flush(); closed = true; restoreGeneration++ }
}
