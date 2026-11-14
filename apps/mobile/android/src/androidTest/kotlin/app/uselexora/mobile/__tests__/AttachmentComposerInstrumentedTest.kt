package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import android.content.ContentValues
import android.content.Intent
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.TransferStore
import app.uselexora.mobile.ui.MainActivity
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class AttachmentComposerInstrumentedTest {
    @Test fun attachmentRemovalPreservesTextFilesOtherPartitionsAndPendingSubmission() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val token = UUID.randomUUID().toString()
        val partition = "fixture:service:profile:generation:device"
        val otherPartition = "attachment-other-$token"
        val scope = "draft:$token"
        val legacyScope = "draft:legacy-$token"
        val inputId = UUID.randomUUID().toString()
        val body = "附件草稿 $token 中文😀"
        val otherBody = "另一个服务的输入 $token"
        val commandId = UUID.randomUUID().toString()
        val records = mutableListOf<JSONObject>()
        val createdFiles = mutableListOf<File>()
        LocalStore(context).use { store -> TransferStore(context).use { transfers ->
            fun attachment(owner: String, name: String, resourceId: String = UUID.randomUUID().toString()): JSONObject {
                val id = UUID.randomUUID().toString()
                val file = File(File(context.filesDir, "staging").apply { mkdirs() }, id)
                    .apply { writeText("真实手机副本 · $name · $token"); createdFiles.add(this) }
                return JSONObject().put("id", id).put("partition", owner).put("scope", scope).put("inputId", inputId)
                    .put("kind", "upload").put("state", "adopted").put("path", file.absolutePath).put("resourceId", resourceId)
                    .put("file", JSONObject().put("name", name).put("mimeType", "text/plain").put("size", file.length()))
                    .also { transfers.save(it); records.add(it) }
            }
            fun value(text: String, resources: List<JSONObject>) = JSONObject().put("inputId", inputId)
                .put("content", MobileContentAdapter.textContent(text).put("panelResourceIds", JSONArray(resources.map { it.getString("resourceId") })))
            fun ids(owner: String): List<String> = store.draft(owner, scope)!!.value.getJSONObject("content").getJSONArray("panelResourceIds")
                .let { values -> (0 until values.length()).map { values.getString(it) } }
            try {
                val removed = attachment(partition, "要移除的资料.txt")
                val retained = attachment(partition, "继续保留的资料.txt")
                val other = attachment(otherPartition, "其他服务的资料.txt", removed.getString("resourceId"))
                store.edit(partition, scope, value(body, listOf(removed, retained)))
                val untouched = store.edit(otherPartition, scope, value(otherBody, listOf(other)))
                store.edit(partition, legacyScope, value("未打开的旧草稿 $token", emptyList()))
                for (target in listOf(scope, legacyScope)) {
                    val legacy = store.draft(partition, target)!!.value.apply { remove("inputId") }
                    assertEquals(1, store.writableDatabase.update("drafts", ContentValues().apply { put("value", legacy.toString()) }, "partition=? AND scope=?", arrayOf(partition, target)))
                }
                val untouchedLegacy = store.draft(partition, legacyScope)!!
                assertFalse(store.draft(partition, scope)!!.value.has("inputId"))
                assertFalse(untouchedLegacy.value.has("inputId"))
                fun assertLegacyUntouched() {
                    val current = store.draft(partition, legacyScope)!!
                    assertFalse(current.value.has("inputId"))
                    assertEquals(untouchedLegacy.value.toString(), current.value.toString())
                    assertEquals(untouchedLegacy.editSequence, current.editSequence)
                }
                val contents = createdFiles.associateWith { it.readText() }
                ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("fixture", true)).use { scenario ->
                    fun input(): String {
                        var text = ""
                        scenario.onActivity { text = it.findViewById<EditText>(MainActivity.INPUT_ID)?.text?.toString().orEmpty() }
                        return text
                    }
                    MobileUiTestDriver.openDrafts()
                    MobileUiTestDriver.click("草稿 · $body")
                    MobileUiTestDriver.click("继续编辑")
                    MobileUiTestDriver.waitUntil { input() == body && MobileUiTestDriver.exists("要移除的资料.txt") }
                    assertTrue(MobileUiTestDriver.enabled("移除附件 要移除的资料.txt"))
                    assertFalse(MobileUiTestDriver.exists("其他服务的资料.txt"))
                    MobileUiTestDriver.click("移除附件 要移除的资料.txt")
                    MobileUiTestDriver.waitUntil { ids(partition) == listOf(retained.getString("resourceId")) && !MobileUiTestDriver.exists("要移除的资料.txt") }
                    assertEquals(body, input())
                    assertTrue(store.draft(partition, scope)!!.value.getString("inputId").isNotBlank())
                    assertLegacyUntouched()
                    assertEquals(body, MobileContentAdapter.text(store.draft(partition, scope)!!.value.getJSONObject("content")))
                    assertEquals(untouched.value.toString(), store.draft(otherPartition, scope)!!.value.toString())
                    assertEquals(untouched.editSequence, store.draft(otherPartition, scope)!!.editSequence)
                    for ((file, text) in contents) assertEquals(text, file.readText())
                    assertEquals("adopted", transfers.list(partition).single { it.getString("id") == removed.getString("id") }.getString("state"))

                    scenario.recreate()
                    MobileUiTestDriver.waitUntil { input() == body && MobileUiTestDriver.exists("继续保留的资料.txt") }
                    assertFalse(MobileUiTestDriver.exists("要移除的资料.txt"))
                    assertTrue(MobileUiTestDriver.enabled("移除附件 继续保留的资料.txt"))
                    val draft = store.draft(partition, scope)!!
                    store.queue(partition, "chat.submitInput", JSONObject().put("commandId", commandId)
                        .put("intent", JSONObject().put("input", JSONObject().put("inputId", draft.value.getString("inputId")).put("content", JSONObject(draft.value.getJSONObject("content").toString())))),
                        JSONObject().put("kind", "submit").put("scope", scope).put("editSequence", draft.editSequence))
                    store.mark(commandId, "unknown")
                    scenario.recreate()
                    MobileUiTestDriver.waitUntil { input() == body && MobileUiTestDriver.exists("继续保留的资料.txt") }
                    assertFalse(MobileUiTestDriver.exists("移除附件 继续保留的资料.txt"))
                    assertEquals(listOf(retained.getString("resourceId")), ids(partition))
                    assertTrue(store.hasPendingDraftCommand(store.draft(partition, scope)!!))
                    assertEquals("unknown", store.outbox(partition).single { it.id == commandId }.state)
                    assertLegacyUntouched()
                    assertEquals(untouched.value.toString(), store.draft(otherPartition, scope)!!.value.toString())
                    for ((file, text) in contents) assertEquals(text, file.readText())
                }
            } finally {
                store.writableDatabase.delete("outbox", "id=? AND partition=?", arrayOf(commandId, partition))
                for (owner in listOf(partition, otherPartition)) store.writableDatabase.delete("drafts", "partition=? AND scope=?", arrayOf(owner, scope))
                store.writableDatabase.delete("drafts", "partition=? AND scope=?", arrayOf(partition, legacyScope))
                for (record in records) transfers.writableDatabase.delete("transfers", "id=? AND partition=?", arrayOf(record.getString("id"), record.getString("partition")))
                createdFiles.forEach { it.delete() }
            }
        } }
    }
}
