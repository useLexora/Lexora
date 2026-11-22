package app.uselexora.mobile

import app.uselexora.mobile.protocol.DraftContext
import app.uselexora.mobile.protocol.MobileContentAdapter
import app.uselexora.mobile.protocol.MobileInputRouting
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.protocol.CommandOutbox
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.storage.LocalDraft
import app.uselexora.mobile.storage.OutboxItem
import app.uselexora.mobile.storage.LocalStore
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LocalInputInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Test fun acceptedSnapshotPreservesLaterTextAndFilesAndNeverConsumesAnotherTask() {
        val partition = "local-input-${java.util.UUID.randomUUID()}"
        LocalStore(context).use { store ->
            store.edit(partition, "global", JSONObject().put("content", MobileContentAdapter.textContent("已发送😀")))
            val inputId = store.inputId(partition, "global")
            store.attach(partition, inputId, "sent-file")
            val original = store.draft(partition, "global")!!
            val other = store.edit(partition, "draft:another", JSONObject().put("content", MobileContentAdapter.textContent("另一个任务")))
            val envelope = JSONObject().put("commandId", store.newId()).put("intent", JSONObject().put("input", JSONObject(original.value.toString())))
            val item = store.queue(partition, "chat.submitInput", envelope, JSONObject().put("kind", "submit").put("scope", "global").put("editSequence", original.editSequence))
            assertTrue(store.hasPendingDraftCommand(original))
            assertFalse(store.hasPendingDraftCommand(other))
            val updated = JSONObject(original.value.toString())
            updated.put("content", MobileContentAdapter.textContent("后写的文字😀"))
            store.edit(partition, "global", updated)
            store.attach(partition, inputId, "sent-file")
            store.attach(partition, inputId, "later-file")
            val receipt = JSONObject().put("decision", "accepted").put("result", JSONObject()).put("target", JSONObject().put("conversationId", "task").put("branchId", "branch"))
            store.resolve(item, receipt)
            val restored = store.draft(partition, "conversation:task:branch")!!
            assertEquals("后写的文字😀", MobileContentAdapter.text(restored.value.getJSONObject("content")))
            assertEquals("[\"later-file\"]", restored.value.getJSONObject("content").getJSONArray("panelResourceIds").toString())
            assertEquals(inputId, store.inputId(partition, restored.scope))
            assertTrue(restored.dirty)
            assertEquals(other.value.toString(), store.draft(partition, other.scope)!!.value.toString())
            val next = store.edit(partition, "global", JSONObject().put("content", MobileContentAdapter.textContent("新任务")))
            assertNotEquals(inputId, next.value.getString("inputId"))
            store.attach(partition, inputId, "late-upload")
            assertEquals(0, store.draft(partition, "global")!!.value.getJSONObject("content").getJSONArray("panelResourceIds").length())
            store.resolve(item, receipt)
            assertEquals("新任务", MobileContentAdapter.text(store.draft(partition, "global")!!.value.getJSONObject("content")))
            assertTrue(store.uploadSubmitted(JSONObject().put("partition", partition).put("inputId", inputId).put("resourceId", "sent-file")))
            assertFalse(store.uploadSubmitted(JSONObject().put("partition", partition).put("inputId", inputId).put("resourceId", "later-file")))
        }
        LocalStore(context).use { store ->
            assertEquals("accepted", store.outbox(partition).single().state)
            assertEquals("后写的文字😀", MobileContentAdapter.text(store.draft(partition, "conversation:task:branch")!!.value.getJSONObject("content")))
            assertNull(store.draft("another-partition", "conversation:task:branch"))
        }
    }

    private fun transient(store: LocalStore, draft: LocalDraft, confirmedRepeat: Boolean = false,
        intent: JSONObject = JSONObject().put("operation", "start").put("input", JSONObject(draft.value.toString()).put("scope", DraftContext.target(draft.scope)))): OutboxItem {
        val envelope = JSONObject().put("commandId", store.newId()).put("expectedServiceInstanceId", "original").put("dataGeneration", "generation")
            .put("intent", intent)
        val effect = JSONObject().put("kind", "submit").put("scope", draft.scope).put("editSequence", draft.editSequence)
            .put("bodySequence", draft.bodySequence).put("untilDecided", true)
        if (confirmedRepeat) effect.put("confirmedRepeat", true)
        return store.queue(draft.partition, "chat.submitInput", envelope, effect)
    }

    @Test fun pendingLookupKeepsOnlyOriginalInputBlockedUntilAuthoritativeAnswerOrExplicitReview() {
        LocalStore(context).use { store ->
            val owner = store.newId()
            val a = store.edit(owner, "global", JSONObject().put("content", MobileContentAdapter.textContent("unsent")))
            val b = store.edit(owner, "draft:other", JSONObject().put("content", MobileContentAdapter.textContent("elsewhere")))
            val unrelated = store.queue(owner, "approvals.resolve", JSONObject().put("commandId", store.newId()))
            val first = transient(store, a)
            val outbox = CommandOutbox(store)
            val missing = JSONObject().put("lookup", "not_found")
            outbox.applyLookup(first, "original", JSONObject().put("lookup", "pending"))
            assertTrue(store.hasPendingDraftCommand(a)); assertFalse(store.hasPendingDraftCommand(b))
            assertEquals(first.id, store.pendingComposerCommands(owner).single().id)
            assertTrue(store.pendingComposerCommands(store.newId()).isEmpty())
            assertTrue(runCatching { transient(store, a) }.isFailure)
            outbox.applyLookup(first, "another-instance", missing)
            assertTrue(store.hasPendingDraftCommand(a))
            store.releaseComposerCommand(first, reviewed = true)
            assertFalse(store.hasPendingDraftCommand(a))
            val second = transient(store, a)
            assertEquals("not_received", outbox.applyLookup(second, "original", missing).state)
            assertEquals(listOf(unrelated.id), store.outbox(owner).map { it.id })
            assertEquals(a.value.toString(), store.draft(owner, "global")!!.value.toString())
            val legacy = store.queue(owner, "composerDrafts.save", JSONObject().put("commandId", store.newId()).put("expectedServiceInstanceId", "original"), JSONObject().put("kind", "save").put("scope", a.scope))
            assertEquals(legacy.id, store.pendingComposerCommands(owner).single().id)
            outbox.applyLookup(legacy, "original", missing)
            assertEquals("not_received", store.outbox(owner).first { it.id == legacy.id }.state)
            assertFalse(store.hasPendingDraftCommand(a))
        }
    }

    @Test fun terminalInputForgetsSnapshotButKeepsFileProofAndDoesNotResendTextWithALaterAttachment() {
        LocalStore(context).use { store ->
            val owner = store.newId()
            val scope = "conversation:task:branch"
            val draft = store.edit(owner, scope, JSONObject().put("content", MobileContentAdapter.textContent("original")))
            val inputId = draft.value.getString("inputId")
            store.attach(owner, inputId, "first")
            val item = transient(store, store.draft(owner, scope)!!)
            store.attach(owner, inputId, "later")
            val accepted = JSONObject().put("decision", "accepted").put("commandId", item.id).put("method", item.method).put("dataGeneration", "generation")
                .put("result", JSONObject()).put("target", JSONObject().put("conversationId", "task").put("branchId", "branch").put("runId", "accepted-run"))
            val lookup = JSONObject().put("lookup", "decided").put("receipt", accepted)
            val outbox = CommandOutbox(store)
            outbox.applyLookup(item, "original", lookup)
            val consumed = store.draft(owner, scope)!!
            assertEquals("", MobileContentAdapter.text(consumed.value.getJSONObject("content")))
            assertEquals("[\"later\"]", consumed.value.getJSONObject("content").getJSONArray("panelResourceIds").toString())
            val transfer = JSONObject().put("partition", owner).put("inputId", inputId).put("resourceId", "first")
            assertTrue(store.uploadSubmitted(transfer)); assertFalse(store.uploadSubmitted(transfer.put("resourceId", "later")))
            assertTrue(store.outbox(owner).isEmpty())
            val edit = store.edit(owner, scope, JSONObject(consumed.value.toString()).put("content", MobileContentAdapter.textContent("next")))
            outbox.applyLookup(item, "original", lookup)
            assertEquals(edit.value.toString(), store.draft(owner, scope)!!.value.toString())
            val rejected = transient(store, edit)
            outbox.applyLookup(rejected, "original", JSONObject().put("lookup", "decided").put("receipt", JSONObject(accepted.toString()).put("commandId", rejected.id).put("decision", "rejected").put("errorCode", "SOURCE_CHANGED")))
            assertEquals(edit.value.toString(), store.draft(owner, scope)!!.value.toString())
            assertTrue(store.outbox(owner).isEmpty())
        }
    }

    @Test fun checkingAnUnknownSendReadsOnlyTheOriginalCommandAndPreservesNewInputOnRejection() {
        val schemas = app.uselexora.mobile.protocol.ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val calls = java.util.concurrent.CopyOnWriteArrayList<Pair<String, String>>()
        SyntheticProductService(schemas, listOf("commands.get", "chat.submitInput")) { call ->
            calls.add(call.method to call.params.getString("commandId"))
            val receipt = JSONObject().put("commandId", call.params.getString("commandId")).put("dataGeneration", call.params.getString("dataGeneration"))
                .put("method", "chat.submitInput").put("decision", "rejected").put("errorCode", "SOURCE_CHANGED").put("decidedAt", java.time.Instant.now().toString())
                .put("target", JSONObject()).put("result", JSONObject())
            call.reply(JSONObject().put("lookup", "decided").put("receipt", receipt))
        }.use { service ->
            val client = service.connect()
            try { LocalStore(context).use { store ->
                val identity = client.identity!!
                val owner = identity.partition
                val scope = "conversation:task:branch"
                val draft = store.edit(owner, scope, JSONObject().put("content", MobileContentAdapter.textContent("original")))
                val envelope = JSONObject().put("commandId", store.newId()).put("expectedServiceInstanceId", identity.serviceInstanceId).put("dataGeneration", identity.dataGeneration)
                    .put("intent", JSONObject().put("operation", "start").put("input", JSONObject(draft.value.toString()).put("scope", DraftContext.target(scope))))
                val original = store.queue(owner, "chat.submitInput", envelope, JSONObject().put("kind", "submit").put("scope", scope)
                    .put("editSequence", draft.editSequence).put("bodySequence", draft.bodySequence).put("untilDecided", true))
                store.mark(original.id, "unknown")
                val next = store.edit(owner, scope, JSONObject(draft.value.toString()).put("content", MobileContentAdapter.textContent("next input")))
                val checked = CommandOutbox(store).reconcile(client, store.pendingComposerCommands(owner).single())
                assertEquals(listOf("commands.get" to original.id), calls.toList())
                assertEquals("rejected", checked.state)
                assertEquals("SOURCE_CHANGED", checked.receipt!!.getString("errorCode"))
                assertEquals(next.value.toString(), store.draft(owner, scope)!!.value.toString())
                assertTrue(store.pendingComposerCommands(owner).isEmpty())
            } } finally { client.close() }
        }
    }

    @Test fun recoveredQueueReceiptUsesOriginalBindingAndConsumesOnlyItsSnapshot() {
        val owner = java.util.UUID.randomUUID().toString(); val scope = "conversation:task:branch"
        val itemId = LocalStore(context).use { store ->
            val input = store.edit(owner, scope, JSONObject().put("content", MobileContentAdapter.textContent("supplement")))
            store.attach(owner, input.value.getString("inputId"), "sent-file")
            val draft = store.draft(owner, scope)!!
            val intent = MobileInputRouting.intent("chat.startTurn", JSONObject(draft.value.toString()).put("scope", DraftContext.target(scope)), setOf("child")) {
                JSONObject().put("mode", "current").put("actorId", "receiver").put("target", JSONObject().put("rootRunId", "root").put("runId", "child"))
            }
            val item = transient(store, draft, intent = intent)
            store.mark(item.id, "unknown"); item.id
        }
        LocalStore(context).use { store ->
            val original = store.pendingComposerCommands(owner).single()
            assertEquals(itemId, original.id)
            val intent = original.envelope.getJSONObject("intent")
            assertEquals("enqueue", intent.getString("operation")); assertEquals("child", intent.getJSONObject("delivery").getJSONObject("target").getString("runId"))
            val current = store.draft(owner, scope)!!; val inputId = current.value.getString("inputId")
            assertEquals("COMMAND_RESULT_UNKNOWN", assertThrows(ProtocolFailure::class.java) { transient(store, current) }.code)
            val outbox = CommandOutbox(store)
            val target = JSONObject().put("conversationId", "task").put("branchId", "wrong").put("queueId", "admitted")
            val receipt = JSONObject().put("decision", "accepted").put("commandId", original.id).put("method", original.method).put("dataGeneration", "generation")
                .put("target", target).put("result", JSONObject())
            val lookup = JSONObject().put("lookup", "decided").put("receipt", receipt)
            assertThrows(ProtocolFailure::class.java) { outbox.applyLookup(original, "original", lookup) }
            assertEquals(current.value.toString(), store.draft(owner, scope)!!.value.toString())
            assertEquals(itemId, store.pendingComposerCommands(owner).single().id)
            store.edit(owner, scope, JSONObject(current.value.toString()).put("content", MobileContentAdapter.textContent("next draft")))
            store.attach(owner, inputId, "next-file")
            target.put("branchId", "branch")
            assertEquals("accepted", outbox.applyLookup(original, "original", lookup).state)
            val remaining = store.draft(owner, scope)!!.value.getJSONObject("content")
            assertEquals("next draft", MobileContentAdapter.text(remaining)); assertEquals("[\"next-file\"]", remaining.getJSONArray("panelResourceIds").toString())
            assertTrue(store.pendingComposerCommands(owner).isEmpty())
            assertTrue(store.uploadSubmitted(JSONObject().put("partition", owner).put("inputId", inputId).put("resourceId", "sent-file")))
        }
    }

    @Test fun ambiguousLegacyTextIsNotErasedOrSilentlySentAgain() {
        LocalStore(context).use { store ->
            val owner = store.newId(); val scope = "conversation:task:branch"
            val draft = store.edit(owner, scope, JSONObject().put("content", MobileContentAdapter.textContent("same")))
            val item = store.queue(owner, "chat.submitInput", JSONObject().put("commandId", store.newId()).put("intent", JSONObject().put("input", draft.value)),
                JSONObject().put("kind", "submit").put("scope", scope).put("editSequence", draft.editSequence))
            store.attach(owner, draft.value.getString("inputId"), "later")
            store.resolve(item, JSONObject().put("decision", "accepted").put("target", JSONObject().put("conversationId", "task").put("branchId", "branch")).put("result", JSONObject()))
            val retained = store.draft(owner, scope)!!
            assertEquals("same", MobileContentAdapter.text(retained.value.getJSONObject("content")))
            assertTrue(runCatching { transient(store, retained) }.exceptionOrNull() is app.uselexora.mobile.storage.SubmittedTextReview)
            assertEquals(listOf(item.id), store.outbox(owner).map { it.id })
            store.attach(owner, retained.value.getString("inputId"), "another")
            assertEquals("DRAFT_CONFLICT", (runCatching { transient(store, retained, confirmedRepeat = true) }.exceptionOrNull() as ProtocolFailure).code)
            val latest = store.draft(owner, scope)!!
            val sent = transient(store, latest, confirmedRepeat = true)
            val content = sent.envelope.getJSONObject("intent").getJSONObject("input").getJSONObject("content")
            assertEquals("same", MobileContentAdapter.text(content))
            assertEquals("[\"later\",\"another\"]", content.getJSONArray("panelResourceIds").toString())
            assertEquals("COMMAND_RESULT_UNKNOWN", (runCatching { transient(store, latest) }.exceptionOrNull() as ProtocolFailure).code)
            assertEquals(setOf(item.id, sent.id), store.outbox(owner).map { it.id }.toSet())
        }
    }

    @Test fun exactAcceptedSnapshotClearsOnlyItsInputAndKeepsTheStableUploadOwner() {
        val partition = "local-input-${java.util.UUID.randomUUID()}"
        LocalStore(context).use { store ->
            val first = store.edit(partition, "global", JSONObject().put("content", MobileContentAdapter.textContent("发送")))
            val item = store.queue(partition, "chat.submitInput", JSONObject().put("commandId", store.newId()).put("intent", JSONObject().put("input", first.value)), JSONObject().put("kind", "submit").put("scope", "global").put("editSequence", first.editSequence))
            store.resolve(item, JSONObject().put("decision", "accepted").put("result", JSONObject()).put("target", JSONObject().put("conversationId", "task").put("branchId", "branch")))
            val next = store.draft(partition, "conversation:task:branch")!!
            assertEquals("", MobileContentAdapter.text(next.value.getJSONObject("content")))
            assertFalse(next.dirty)
            assertEquals(first.value.getString("inputId"), next.value.getString("inputId"))
        }
    }
}
