package app.uselexora.mobile

import android.os.Handler
import android.os.Looper
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.protocol.DraftContext
import app.uselexora.mobile.protocol.MobileContentAdapter
import app.uselexora.mobile.session.MobileComposerSession
import app.uselexora.mobile.storage.*
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class ComposerMemoryInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val owner = "memory-${UUID.randomUUID()}"
    private val scope = DraftContext.newTaskKey(null)
    private fun edit(text: String) = ComposerEdit(text, null, "{}", null, null)
    private fun text(draft: LocalDraft?) = draft?.value?.getJSONObject("content")?.let { MobileContentAdapter.text(it) }

    @Test fun burstWritesOnlyLatestRevisionAndFlushesBothSidesOfIdentitySwitch() {
        LocalStore(instrumentation.targetContext).use { store -> TransferStore(instrumentation.targetContext).use { transfers ->
            val disk = Executors.newSingleThreadExecutor()
            val handler = Handler(Looper.getMainLooper())
            val session = MobileComposerSession(store, ComposerMemory(store, transfers), disk, handler) { handler.post(it) }
            try {
                instrumentation.runOnMainSync {
                    session.select(owner, scope)
                    repeat(100) { i -> session.persist({ edit("edit-$i") }, {}, {}) }
                    session.select("$owner-other", scope)
                    session.persist({ edit("另一身份") }, {}, {})
                    session.close()
                }
                disk.submit { }.get(5, TimeUnit.SECONDS)
                for ((partition, value) in listOf(owner to "edit-99", "$owner-other" to "另一身份")) {
                    val saved = store.drafts(partition).single()
                    assertEquals(value, text(saved)); assertEquals(1L, saved.editSequence)
                }
            } finally { disk.shutdownNow() }
        } }
    }

    @Test fun clearingRemovesOnlyAnUnownedEmptyInputAndKeepsLegacyContentAndUploads() {
        LocalStore(instrumentation.targetContext).use { store -> TransferStore(instrumentation.targetContext).use { transfers ->
            val memory = ComposerMemory(store, transfers)
            assertNull(memory.save(owner, scope, edit("")))
            val other = store.edit(owner, "conversation:other:branch", JSONObject().put("content", MobileContentAdapter.textContent("other")))
            val original = store.edit(owner, scope, JSONObject().put("content", MobileContentAdapter.textContent("遗留正文"))
                .put("draftId", "old").put("revision", "17").put("participants", JSONObject().put("leaderId", "actor")))
            val id = original.value.getString("inputId")
            store.attach(owner, id, "resource")
            val onlyAttachment = memory.save(owner, scope, edit(""))!!
            assertEquals("", text(onlyAttachment)); assertEquals("resource", onlyAttachment.value.getJSONObject("content").getJSONArray("panelResourceIds").getString(0))
            assertEquals("old", onlyAttachment.value.getString("draftId")); assertEquals("17", onlyAttachment.value.getString("revision"))
            assertEquals("actor", onlyAttachment.value.getJSONObject("participants").getString("leaderId"))
            store.detach(owner, id, "resource")
            val transfer = JSONObject().put("id", store.newId()).put("partition", owner).put("scope", scope).put("inputId", id).put("kind", "upload").put("state", "staged")
            transfers.save(transfer)
            assertEquals(id, memory.save(owner, scope, edit(""))!!.value.getString("inputId"))
            transfers.save(transfer.put("state", "cancelled"))
            assertNull(memory.save(owner, scope, edit(""))); assertNull(store.draft(owner, scope))
            assertEquals("other", text(store.draft(owner, other.scope)))
        } }
    }

    @Test fun settingsAndAttachmentsPreserveLegacyBodyVersionAndNoOpsDoNotWrite() {
        LocalStore(instrumentation.targetContext).use { store -> TransferStore(instrumentation.targetContext).use { transfers ->
            val memory = ComposerMemory(store, transfers)
            val content = MobileContentAdapter.textContent("first")
            content.getJSONArray("body").getJSONObject(0).getJSONArray("content")
                .put(JSONObject().put("type", "hard_break")).put(JSONObject().put("type", "text").put("text", "second😀"))
            val originalBody = content.getJSONArray("body").toString()
            val legacy = JSONObject().put("content", content).put("reviewSubmittedText", true)
            fun seed(scope: String) = store.writableDatabase.execSQL("INSERT INTO drafts VALUES (?,?,17,?,16)", arrayOf(owner, scope, legacy.toString()))
            seed(scope)
            val id = store.inputId(owner, scope)
            seed("other")
            val settings = edit("first\nsecond😀").copy(execution = "{\"a\":1,\"b\":2}")
            val configured = memory.save(owner, scope, settings)!!
            assertEquals(19L, configured.editSequence); assertEquals(17L, configured.bodySequence)
            val reordered = settings.copy(execution = "{\"b\":2,\"a\":1}")
            assertEquals(configured.editSequence, memory.save(owner, scope, reordered)!!.editSequence)
            store.updateExecutionConfig(owner, scope, JSONObject(reordered.execution))
            store.attach(owner, id, "a"); store.attach(owner, id, "b", replacingResourceId = "a")
            store.attach(owner, id, "b"); store.detach(owner, id, "missing")
            memory.detach(owner, scope, id, "b")
            val retained = store.draft(owner, scope)!!
            assertEquals(configured.editSequence + 3, retained.editSequence)
            assertEquals(17L, retained.bodySequence); assertEquals(16L, retained.confirmedSequence)
            assertEquals(originalBody, retained.value.getJSONObject("content").getJSONArray("body").toString())
            assertTrue(retained.value.getBoolean("reviewSubmittedText"))
            assertFalse(store.draft(owner, "other")!!.value.has("inputId"))
            val changed = memory.save(owner, scope, settings.copy(text = "changed"))!!
            assertEquals(retained.editSequence + 1, changed.bodySequence)
            assertFalse(changed.value.has("reviewSubmittedText"))
        } }
    }

    @Test fun settingsAndAttachmentsNeverFlattenReadOnlyBody() {
        LocalStore(instrumentation.targetContext).use { store -> TransferStore(instrumentation.targetContext).use { transfers ->
            val content = MobileContentAdapter.textContent("marked")
            content.getJSONArray("body").getJSONObject(0).getJSONArray("content").getJSONObject(0).put("marks", org.json.JSONArray().put("bold"))
            val draft = store.edit(owner, scope, JSONObject().put("content", content))
            val id = draft.value.getString("inputId")
            store.updateExecutionConfig(owner, scope, JSONObject().put("mode", "read_only"))
            store.attach(owner, id, "file")
            val memory = ComposerMemory(store, transfers)
            memory.detach(owner, scope, id, "file")
            val failure = runCatching { memory.save(owner, scope, edit("preview")) }.exceptionOrNull()
            assertEquals("DRAFT_READ_ONLY", failure?.message)
            val retained = store.draft(owner, scope)!!
            assertEquals(draft.bodySequence, retained.bodySequence)
            assertEquals(draft.editSequence + 3, retained.editSequence)
            assertEquals(content.toString(), retained.value.getJSONObject("content").toString())
        } }
    }

    @Test fun lateReceiptDoesNotConsumeTextThatWasEditedBackToTheSentWords() {
        LocalStore(instrumentation.targetContext).use { store -> TransferStore(instrumentation.targetContext).use { transfers ->
            val memory = ComposerMemory(store, transfers)
            val sent = memory.save(owner, scope, edit("same words"))!!
            val item = store.queue(owner, "chat.submitInput", JSONObject().put("commandId", store.newId()).put("intent", JSONObject().put("input", sent.value)),
                JSONObject().put("kind", "submit").put("scope", scope).put("editSequence", sent.editSequence).put("bodySequence", sent.bodySequence))
            memory.save(owner, scope, edit("different"))
            val restored = memory.save(owner, scope, edit("same words"))!!
            assertTrue(restored.bodySequence > sent.bodySequence)
            store.resolve(item, JSONObject().put("decision", "accepted").put("result", JSONObject()).put("target", JSONObject().put("conversationId", "new").put("branchId", "branch")))
            val remaining = store.draft(owner, "conversation:new:branch")!!
            assertEquals("same words", text(remaining)); assertEquals(restored.bodySequence, remaining.bodySequence)
        } }
    }

    @Test fun attachmentPublicationKeepsThePreviouslyCommittedInputIdAndOptionsEvenOnInterruption() {
        LocalStore(instrumentation.targetContext).use { store -> TransferStore(instrumentation.targetContext).use { transfers ->
            val token = store.newId()
            assertTrue(runCatching { store.publishAttachment(owner, scope, null) { id ->
                transfers.save(JSONObject().put("id", token).put("partition", owner).put("inputId", id).put("scope", scope).put("kind", "upload").put("state", "staged"))
                error("interrupted after transfer commit")
            } }.isFailure)
            val id = transfers.list(owner).single().getString("inputId")
            assertEquals(id, store.draft(owner, scope)!!.value.getString("inputId"))
            val memory = ComposerMemory(store, transfers)
            val options = ComposerEdit("", "{\"modelId\":\"selected\"}", "{}", "space", "Space", keepSettings = true)
            val draft = memory.save(owner, DraftContext.newTaskKey("space"), options)!!
            assertEquals("space", DraftContext.spaceId(draft.value)); assertEquals("selected", draft.value.getJSONObject("modelSelection").getString("modelId"))
            assertEquals(draft.value.getString("inputId"), store.inputId(owner, draft.scope))
        } }
    }

    @Test fun failedWriteSurvivesScopeSwitchAndCanBeRetriedFromANewSession() {
        LocalStore(instrumentation.targetContext).use { store -> TransferStore(instrumentation.targetContext).use { transfers ->
            val disk = Executors.newSingleThreadExecutor()
            val handler = Handler(Looper.getMainLooper())
            fun session() = MobileComposerSession(store, ComposerMemory(store, transfers), disk, handler) { handler.post(it) }
            try {
                store.writableDatabase.execSQL("CREATE TEMP TRIGGER fail_memory_write BEFORE INSERT ON drafts WHEN NEW.partition='$owner' BEGIN SELECT RAISE(ABORT,'full'); END")
                instrumentation.runOnMainSync {
                    val original = session(); original.select(owner, scope)
                    original.persist({ edit("pending on full disk") }, {}, {})
                    original.select("$owner-other", scope); original.close()
                }
                disk.submit { }.get(5, TimeUnit.SECONDS)
                assertNull(store.draft(owner, scope))
                store.writableDatabase.execSQL("DROP TRIGGER fail_memory_write")
                val restored = java.util.concurrent.CompletableFuture<String?>()
                instrumentation.runOnMainSync {
                    val replacement = session(); replacement.select(owner, scope)
                    replacement.restore(::text, ready = { _, value -> restored.complete(value); replacement.close() }, failed = { restored.completeExceptionally(AssertionError("restore failed")) })
                }
                assertEquals("pending on full disk", restored.get(5, TimeUnit.SECONDS))
                assertEquals("pending on full disk", text(store.draft(owner, scope)))
            } finally { disk.shutdownNow() }
        } }
    }

    @Test fun receiptThatMovedTheOwnerDoesNotLoseTheBufferedTailOrOverwriteTheNextInput() {
        LocalStore(instrumentation.targetContext).use { store -> TransferStore(instrumentation.targetContext).use { transfers ->
            val memory = ComposerMemory(store, transfers)
            val sent = memory.save(owner, scope, edit("submitted"))!!
            val item = store.queue(owner, "chat.submitInput", JSONObject().put("commandId", store.newId()).put("intent", JSONObject().put("input", sent.value)),
                JSONObject().put("kind", "submit").put("scope", scope).put("editSequence", sent.editSequence))
            store.resolve(item, JSONObject().put("decision", "accepted").put("result", JSONObject()).put("target", JSONObject().put("conversationId", "new").put("branchId", "branch")))
            memory.save(owner, scope, edit("next new task"))
            memory.save(owner, scope, edit("late tail"), sent.value.getString("inputId"))
            assertEquals("late tail", text(store.draft(owner, "conversation:new:branch")))
            assertEquals("next new task", text(store.draft(owner, scope)))
        } }
    }
}
