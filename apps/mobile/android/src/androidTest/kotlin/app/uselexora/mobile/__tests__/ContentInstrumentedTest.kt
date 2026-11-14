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
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.ui.MainActivity
import app.uselexora.mobile.MobileUiTestDriver.click
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
            val copiedId = store.newId()
            val local = store.edit(owner, "draft:$copiedId", JSONObject().put("content", sourceContent))
            val opaqueId = store.newId()
            val opaque = store.edit(owner, "draft:$opaqueId", JSONObject().put("content", large.getJSONObject("content")))
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
                MobileUiTestDriver.awaitConnected()
                MobileUiTestDriver.openDrafts(); click("草稿 · 跨端中文😀", prefix = true); click("查看内容")
                waitFor { var restored = false; scenario.onActivity { restored = it.findViewById<EditText>(MainActivity.INPUT_ID)?.text?.toString().orEmpty().contains("引用原文😀") }; restored }
                assertEquals(sourceContent.toString(), store.draft(owner, local.scope)!!.value.getJSONObject("content").toString())
                val commandCount = store.outbox(owner).size
                scenario.onActivity { activity ->
                    assertFalse(activity.findViewById<EditText>(MainActivity.INPUT_ID).isEnabled)
                }
                assertTrue(MobileUiTestDriver.exists("发送"))
                assertFalse(MobileUiTestDriver.enabled("发送"))
                val failure = runCatching { MobileInputCommands(store).send(client, local, DraftContext.target(local.scope)) }.exceptionOrNull()
                assertEquals("CONTENT_UNSUPPORTED", (failure as? ProtocolFailure)?.code)
                assertEquals(commandCount, store.outbox(owner).size)
                scenario.recreate()
                waitFor { var restored = false; scenario.onActivity { restored = it.findViewById<EditText>(MainActivity.INPUT_ID)?.text?.toString().orEmpty().contains("引用原文😀") }; restored }
                instrumentation.uiAutomation.waitForIdle(700, 5000)
                instrumentation.uiAutomation.takeScreenshot()?.let { bitmap -> File(context.filesDir, "content-$token.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
                val opaqueCount = store.outbox(owner).size
                MobileUiTestDriver.openDrafts(); click("草稿 · 请在桌面端查看此内容"); click("查看内容")
                waitFor { var restored = false; scenario.onActivity { restored = it.findViewById<EditText>(MainActivity.INPUT_ID)?.text?.toString().orEmpty() == "请在桌面端查看此内容" }; restored }
                assertTrue(MobileUiTestDriver.exists("发送"))
                assertFalse(MobileUiTestDriver.enabled("发送"))
                assertEquals(opaque.value.getJSONObject("content").toString(), store.draft(owner, "draft:$opaqueId")!!.value.getJSONObject("content").toString())
                assertEquals(opaqueCount, store.outbox(owner).size)
                assertEquals("手机当前输入😀", MobileContentAdapter.text(store.draft(owner, "global")!!.value.getJSONObject("content")))
                val forbiddenId = store.newId()
                val forbidden = MobileContentAdapter.textContent("")
                forbidden.getJSONArray("body").getJSONObject(0).getJSONArray("content").put(JSONObject().put("type", "prompt_directive").put("directive", "slash_command").put("commandMode", "action").put("commandId", "desktop-only").put("value", "/desktop-only"))
                val blocked = runCatching { client.call("chat.submitInput", JSONObject().put("commandId", store.newId()).put("dataGeneration", client.identity!!.dataGeneration).put("expectedServiceInstanceId", client.identity!!.serviceInstanceId)
                    .put("intent", JSONObject().put("operation", "start").put("input", JSONObject().put("inputId", forbiddenId).put("scope", JSONObject().put("kind", "task").put("draftId", forbiddenId).put("spaceId", JSONObject.NULL))
                        .put("content", forbidden).put("modelSelection", JSONObject.NULL).put("executionConfig", source.getJSONObject("executionConfig")).put("participants", JSONObject.NULL)))) }.exceptionOrNull()
                assertEquals("ACTION_NOT_ALLOWED", (blocked as? ProtocolFailure)?.code)
                val result = JSONObject().put("copiedId", copiedId).put("content", local.value.getJSONObject("content")).put("opaqueId", opaqueId)
                    .put("richInputReadOnly", true).put("unsupportedInputPreserved", true).put("forbiddenActionRejected", true).put("noImplicitSend", true)
                File(context.filesDir, "content-$token-result.json").writeText(result.toString())
            }
        } } finally { client.close(); connection.description()?.let { connection.logout(it) } }
    }
}
