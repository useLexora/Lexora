package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.SecretStore
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RecoveryInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    @Test fun durableDraftSurvivesNewDatabaseConnectionAndLateAcknowledgements() {
        val partition = "test-${java.util.UUID.randomUUID()}"
        LocalStore(context).use { store ->
            val first = store.edit(partition, "global", JSONObject().put("content", MobileContentAdapter.textContent("原输入😀")))
            store.edit(partition, "global", JSONObject().put("content", MobileContentAdapter.textContent("发送期间的新输入")))
            store.acknowledge(partition, "global", first.editSequence, "9007199254740992", true)
        }
        LocalStore(context).use { store ->
            val recovered = store.draft(partition, "global")!!
            assertEquals("发送期间的新输入", MobileContentAdapter.text(recovered.value.getJSONObject("content")))
            assertEquals("9007199254740992", recovered.value.getString("revision"))
            assertTrue(recovered.dirty)
            assertNull(store.draft("another-generation", "global"))
        }
    }
    @Test fun unknownCommandRetainsItsOriginalIdentityAndIntent() {
        val partition = "test-${java.util.UUID.randomUUID()}"
        val id = java.util.UUID.randomUUID().toString()
        val envelope = JSONObject().put("commandId", id).put("dataGeneration", "generation").put("intent", JSONObject().put("draftId", "original"))
        LocalStore(context).use { store -> store.queue(partition, "chat.startTurn", envelope); store.mark(id, "unknown") }
        LocalStore(context).use { store ->
            val record = store.outbox(partition).single()
            assertEquals(id, record.id)
            assertEquals("unknown", record.state)
            assertEquals(envelope.toString(), record.envelope.toString())
        }
    }
    @Test fun receiptAndDraftAcknowledgementCommitTogetherAndReplayDoesNotClearANewDraft() {
        val partition = "test-${java.util.UUID.randomUUID()}"
        val id = java.util.UUID.randomUUID().toString()
        val receipt = JSONObject().put("decision", "accepted").put("result", JSONObject().put("draftReceipt", JSONObject().put("committedRevision", "8")))
            .put("target", JSONObject().put("conversationId", "conversation").put("branchId", "branch"))
        LocalStore(context).use { store ->
            val first = store.edit(partition, "global", JSONObject().put("content", MobileContentAdapter.textContent("已发送")))
            val item = store.queue(partition, "chat.startTurn", JSONObject().put("commandId", id), JSONObject().put("kind", "send").put("scope", "global").put("editSequence", first.editSequence))
            store.mark(id, "unknown")
            store.edit(partition, "global", JSONObject().put("content", MobileContentAdapter.textContent("发送后继续输入😀")))
            store.resolve(item, receipt)
            store.edit(partition, "global", JSONObject().put("content", MobileContentAdapter.textContent("另一条新任务")))
            store.resolve(item, receipt)
        }
        LocalStore(context).use { store ->
            assertEquals("accepted", store.outbox(partition).single().state)
            assertEquals("发送后继续输入😀", MobileContentAdapter.text(store.draft(partition, "conversation:conversation:branch")!!.value.getJSONObject("content")))
            assertEquals("另一条新任务", MobileContentAdapter.text(store.draft(partition, "global")!!.value.getJSONObject("content")))
        }
    }
    @Test fun invalidLocalAcknowledgementRollsBackTheReceiptToo() {
        val partition = "test-${java.util.UUID.randomUUID()}"
        LocalStore(context).use { store ->
            store.edit(partition, "global", JSONObject().put("content", MobileContentAdapter.textContent("保留")))
            val id = java.util.UUID.randomUUID().toString()
            val item = store.queue(partition, "composerDrafts.save", JSONObject().put("commandId", id), JSONObject().put("kind", "save").put("scope", "global").put("editSequence", 99))
            store.mark(id, "unknown")
            assertTrue(runCatching { store.resolve(item, JSONObject().put("decision", "accepted").put("result", JSONObject().put("revision", "2"))) }.isFailure)
            assertEquals("unknown", store.outbox(partition).single().state)
            assertEquals("保留", MobileContentAdapter.text(store.draft(partition, "global")!!.value.getJSONObject("content")))
        }
    }
    @Test fun unresolvedCommandsBlockOnlyTheirOwnDraft() {
        val partition = "test-${java.util.UUID.randomUUID()}"
        LocalStore(context).use { store ->
            val draft = store.edit(partition, "global", JSONObject().put("content", MobileContentAdapter.textContent("继续输入")))
            store.queue(partition, "approvals.resolve", JSONObject().put("commandId", store.newId()))
            store.queue(partition, "composerDrafts.save", JSONObject().put("commandId", store.newId()), JSONObject().put("scope", "another-draft"))
            assertFalse(store.hasPendingDraftCommand(draft))
            val item = store.queue(partition, "composerDrafts.save", JSONObject().put("commandId", store.newId()), JSONObject().put("scope", "global"))
            assertTrue(store.hasPendingDraftCommand(draft))
            store.mark(item.id, "not_found")
            assertTrue(store.hasPendingDraftCommand(draft))
            store.resolve(item, JSONObject().put("decision", "rejected"))
            assertFalse(store.hasPendingDraftCommand(draft))
        }
    }
    @Test fun lateAttachmentReceiptDoesNotAttachToAReplacementDraft() {
        val partition = "test-${java.util.UUID.randomUUID()}"
        LocalStore(context).use { store ->
            val item = store.queue(partition, "uploads.adopt", JSONObject().put("commandId", store.newId()).put("intent", JSONObject().put("draftId", "old")), JSONObject().put("scope", "global"))
            store.edit(partition, "global", JSONObject().put("draftId", "replacement").put("content", MobileContentAdapter.textContent("新草稿")))
            store.resolve(item, JSONObject().put("decision", "accepted").put("result", JSONObject().put("resourceId", "old-attachment").put("revision", "3")))
            val current = store.draft(partition, "global")!!.value
            assertEquals("新草稿", MobileContentAdapter.text(current.getJSONObject("content")))
            assertEquals(0, current.getJSONObject("content").getJSONArray("panelResourceIds").length())
            assertFalse(current.has("revision"))
            assertEquals("accepted", store.outbox(partition).single().state)
        }
    }
    @Test fun adoptedAttachmentRemainsUnsynchronizedAndLateSaveDoesNotConfirmIt() {
        val partition = "test-${java.util.UUID.randomUUID()}"
        LocalStore(context).use { store ->
            val saved = store.edit(partition, "global", JSONObject().put("draftId", "draft").put("content", MobileContentAdapter.textContent("原文")))
            store.acknowledge(partition, "global", saved.editSequence, "2", false)
            val item = store.queue(partition, "uploads.adopt", JSONObject().put("commandId", store.newId()).put("intent", JSONObject().put("draftId", "draft").put("expectedRevision", "2")), JSONObject().put("scope", "global"))
            val receipt = JSONObject().put("decision", "accepted").put("result", JSONObject().put("resourceId", "attachment").put("revision", "3"))
            store.resolve(item, receipt)
            val adopted = store.draft(partition, "global")!!
            assertTrue(adopted.dirty)
            assertEquals(saved.editSequence + 1, adopted.editSequence)
            store.acknowledge(partition, "global", saved.editSequence, "2", false)
            store.resolve(item, receipt)
            val retained = store.draft(partition, "global")!!
            assertTrue(retained.dirty)
            assertEquals(adopted.editSequence, retained.editSequence)
            assertEquals("3", retained.value.getString("revision"))
            assertEquals(1, retained.value.getJSONObject("content").getJSONArray("panelResourceIds").length())
        }
    }
    @Test fun remoteRecoveryPreservesAllFieldsAndRejectsDirtyPendingReadOnlyAndOlderRevisions() {
        val partition = "test-${java.util.UUID.randomUUID()}"
        val remote = JSONObject().put("draftId", "remote").put("revision", "9007199254740993").put("writable", true)
            .put("scope", JSONObject().put("kind", "message_followup").put("conversationId", "task").put("branchId", "branch").put("assistantMessageId", "reply"))
            .put("content", JSONObject().put("kind", "editable").put("content", MobileContentAdapter.textContent("服务已保存").apply { getJSONArray("panelResourceIds").put("attachment") }))
            .put("modelSelection", JSONObject().put("providerId", "provider").put("modelId", "model").put("reasoning", "high").put("serviceTier", JSONObject.NULL))
            .put("executionConfig", JSONObject().put("executionProfile", "read_only").put("approvalPolicy", "manual"))
            .put("participants", JSONObject().put("leaderId", "leader").put("actorIds", org.json.JSONArray().put("leader")))
        LocalStore(context).use { store ->
            val imported = store.importDraft(partition, remote)
            assertEquals("message-followup:task:branch:reply", imported.scope)
            assertFalse(imported.dirty)
            assertEquals("attachment", imported.value.getJSONObject("content").getJSONArray("panelResourceIds").getString(0))
            for (key in listOf("modelSelection", "executionConfig", "participants", "scope")) assertEquals(remote.get(key).toString(), imported.value.get(key).toString())
            val original = imported.value.toString()
            assertTrue(runCatching { store.importDraft(partition, JSONObject(remote.toString()).put("revision", "9007199254740992")) }.isFailure)
            assertTrue(runCatching { store.importDraft(partition, JSONObject(remote.toString()).put("writable", false)) }.isFailure)
            val pending = store.queue(partition, "composerDrafts.save", JSONObject().put("commandId", store.newId()), JSONObject().put("scope", imported.scope))
            assertTrue(runCatching { store.importDraft(partition, remote) }.isFailure)
            assertEquals(original, store.draft(partition, imported.scope)!!.value.toString())
            store.mark(pending.id, "rejected")
            store.edit(partition, imported.scope, JSONObject(imported.value.toString()).put("content", MobileContentAdapter.textContent("本机未同步尾部")))
            assertTrue(runCatching { store.importDraft(partition, remote) }.isFailure)
            assertEquals("本机未同步尾部", MobileContentAdapter.text(store.draft(partition, imported.scope)!!.value.getJSONObject("content")))
            assertNull(store.draft("another-identity", imported.scope))
        }
    }
    @Test fun remoteRecoveryKeepsRichAndUnsupportedContentReadOnlyWithoutFlatteningIt() {
        LocalStore(context).use { store ->
            for (content in listOf(
                JSONObject().put("kind", "editable").put("content", MobileContentAdapter.textContent("保留格式").put("unknownField", "kept")),
                JSONObject().put("kind", "unsupported").put("summary", "新版内容").put("opaque", "kept")
            )) {
                val remote = JSONObject().put("draftId", "draft").put("revision", "1").put("writable", true)
                    .put("scope", JSONObject().put("kind", "task").put("draftId", "draft").put("spaceId", JSONObject.NULL)).put("content", content)
                val recovered = store.importDraft("test-${java.util.UUID.randomUUID()}", remote)
                assertFalse(MobileContentAdapter.canEditAsText(recovered.value.getJSONObject("content")))
                assertEquals((content.optJSONObject("content") ?: content).toString(), recovered.value.getJSONObject("content").toString())
            }
        }
    }
    @Test fun keystoreSecretIsEncryptedAndCanBeRecovered() {
        val store = SecretStore(context, "verification")
        val value = JSONObject().put("credential", "fixture-${java.util.UUID.randomUUID()}")
        store.write(value)
        assertEquals(value.toString(), SecretStore(context, "verification").read()!!.toString())
        val file = java.io.File(context.noBackupFilesDir, "verification.bin")
        assertFalse(file.readText().contains(value.getString("credential")))
        store.clear()
    }
}
