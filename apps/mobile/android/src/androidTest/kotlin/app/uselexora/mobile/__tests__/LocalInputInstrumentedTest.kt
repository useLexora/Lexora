package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
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
