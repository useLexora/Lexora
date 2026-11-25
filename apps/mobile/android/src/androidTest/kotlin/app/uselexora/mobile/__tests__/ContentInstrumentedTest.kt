package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import android.content.Intent
import android.os.ParcelFileDescriptor
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.protocol.DraftContext
import app.uselexora.mobile.protocol.MobileInputCommands
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.LocalDraft
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.ui.MainActivity
import app.uselexora.mobile.MobileUiTestDriver.waitUntil as waitFor
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class ContentInstrumentedTest {
    @Test fun legacyLocalContentSurvivesRecoveryButUnsupportedEditingAndActionsNeverSend() {
        val token = InstrumentationRegistry.getArguments().getString("contentWorkflowToken")
        assumeTrue(token?.matches(Regex("[a-f0-9-]{36}")) == true)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val config = JSONObject(ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand("cat /data/local/tmp/lexora-content-$token.json")).bufferedReader().use { it.readText() })
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val connection = MobileConnection(context, schemas, BuildConfig.VERSION_NAME)
        connection.pair(config.getJSONObject("pairing").toString())
        val client = connection.connect()!!
        try { LocalStore(context).use { store ->
            val owner = client.identity!!.partition
            store.edit(owner, "global", JSONObject().put("content", MobileContentAdapter.textContent("手机当前输入😀")))
            val source = client.call("composerDrafts.get", JSONObject().put("draftId", config.getString("draftId")))
            val sourceContent = source.getJSONObject("content").getJSONObject("content")
            assertFalse(MobileContentAdapter.canEditAsText(sourceContent))
            assertTrue(MobileContentAdapter.text(sourceContent).contains("引用原文😀"))
            assertTrue(MobileContentAdapter.text(sourceContent).contains("原来的任务"))
            val large = client.call("composerDrafts.get", JSONObject().put("draftId", config.getString("largeDraftId")))
            assertEquals("unsupported", large.getJSONObject("content").getString("kind"))
            assertEquals("请在桌面端查看此内容", MobileContentAdapter.text(large.getJSONObject("content")))
            val scope = DraftContext.newTaskKey(null)
            val commands = store.outbox(owner).map { it.id }
            fun checkReadOnly(content: JSONObject, capture: Boolean): LocalDraft {
                val seeded = store.edit(owner, scope, JSONObject().put("content", content))
                val expected = MobileContentAdapter.text(content)
                ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
                    MobileUiTestDriver.awaitConnected()
                    MobileUiTestDriver.openUnassignedNewTask()
                    fun awaitReadOnly() = waitFor {
                        var matches = false
                        scenario.onActivity {
                            val field = it.findViewById<EditText>(MainActivity.INPUT_ID)
                            matches = field != null && !field.isEnabled && field.text.toString() == expected
                        }
                        matches && MobileUiTestDriver.exists("发送") && !MobileUiTestDriver.enabled("发送")
                    }
                    awaitReadOnly()
                    scenario.recreate()
                    awaitReadOnly()
                    if (capture) instrumentation.uiAutomation.takeScreenshot()?.let { bitmap ->
                        try { File(context.filesDir, "content-$token.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) } }
                        finally { bitmap.recycle() }
                    }
                }
                val preserved = store.draft(owner, scope)!!
                assertEquals(content.toString(), preserved.value.getJSONObject("content").toString())
                val failure = runCatching { MobileInputCommands(store).send(client, preserved, DraftContext.target(scope)) }.exceptionOrNull()
                assertEquals("CONTENT_UNSUPPORTED", (failure as? ProtocolFailure)?.code)
                assertEquals(commands, store.outbox(owner).map { it.id })
                assertEquals(seeded.editSequence, preserved.editSequence)
                return preserved
            }
            val local = checkReadOnly(sourceContent, capture = true)
            assertEquals(1, store.writableDatabase.delete("drafts", "partition=? AND scope=? AND edit_sequence=?",
                arrayOf(owner, scope, local.editSequence.toString())))
            val opaque = checkReadOnly(large.getJSONObject("content"), capture = false)
            assertEquals("手机当前输入😀", MobileContentAdapter.text(store.draft(owner, "global")!!.value.getJSONObject("content")))
            val forbiddenId = store.newId()
            val forbidden = MobileContentAdapter.textContent("")
            forbidden.getJSONArray("body").getJSONObject(0).getJSONArray("content").put(JSONObject().put("type", "prompt_directive").put("directive", "slash_command").put("commandMode", "action").put("commandId", "desktop-only").put("value", "/desktop-only"))
            val blocked = runCatching { client.call("chat.submitInput", JSONObject().put("commandId", store.newId()).put("dataGeneration", client.identity!!.dataGeneration).put("expectedServiceInstanceId", client.identity!!.serviceInstanceId)
                .put("intent", JSONObject().put("operation", "start").put("input", JSONObject().put("inputId", forbiddenId).put("scope", JSONObject().put("kind", "task").put("draftId", forbiddenId).put("spaceId", JSONObject.NULL))
                    .put("content", forbidden).put("modelSelection", JSONObject.NULL).put("executionConfig", source.getJSONObject("executionConfig")).put("participants", JSONObject.NULL)))) }.exceptionOrNull()
            assertEquals("ACTION_NOT_ALLOWED", (blocked as? ProtocolFailure)?.code)
            val result = JSONObject().put("copiedId", local.value.getString("inputId")).put("content", local.value.getJSONObject("content")).put("opaqueId", opaque.value.getString("inputId"))
                .put("richInputReadOnly", true).put("unsupportedInputPreserved", true).put("forbiddenActionRejected", true).put("noImplicitSend", true)
            File(context.filesDir, "content-$token-result.json").writeText(result.toString())
        } } finally { client.close(); connection.description()?.let { connection.logout(it) } }
    }
}
