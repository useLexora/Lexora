package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import android.content.Intent
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.ui.MainActivity
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.MobileUiTestDriver.click as clickText
import app.uselexora.mobile.MobileUiTestDriver.waitUntil as waitFor
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class DraftUiInstrumentedTest {
    @Test fun newTaskReopensTheLatestInputWithoutSubmittingOrReplacingAnOlderDraft() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val partition = "fixture:service:profile:generation:device"
        val legacy = "draft:${java.util.UUID.randomUUID()}"
        val current = app.uselexora.mobile.protocol.DraftContext.newTaskKey(null)
        val body = "保留旧输入 ${java.util.UUID.randomUUID()}"
        val latest = "自然恢复新输入 ${java.util.UUID.randomUUID()}"
        LocalStore(context).use { store ->
            store.edit(partition, legacy, JSONObject().put("content", MobileContentAdapter.textContent(body)))
            val outbox = store.outbox(partition).map { it.id }.toSet()
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("fixture", true)).use { scenario ->
                fun ready(expected: String? = null): Boolean {
                    var matches = false
                    scenario.onActivity {
                        val field = it.findViewById<EditText>(MainActivity.INPUT_ID)
                        matches = field != null && field.isEnabled && (expected == null || field.text.toString() == expected)
                    }
                    return matches && MobileUiTestDriver.exists("任务设置")
                }
                MobileUiTestDriver.clickTag("new-task")
                waitFor { ready() }
                scenario.onActivity { it.findViewById<EditText>(MainActivity.INPUT_ID).setText(latest) }
                clickText("返回")
                MobileUiTestDriver.clickTag("new-task")
                waitFor { ready(latest) }
                scenario.recreate()
                waitFor { ready(latest) }
                scenario.onActivity { it.findViewById<EditText>(MainActivity.INPUT_ID).setText("") }
                waitFor { store.draft(partition, current) == null }
                assertFalse(MobileUiTestDriver.enabled("发送"))
                assertEquals(body, MobileContentAdapter.text(store.draft(partition, legacy)!!.value.getJSONObject("content")))
                assertEquals(outbox, store.outbox(partition).map { it.id }.toSet())
                InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()?.let { bitmap ->
                    try { java.io.File(context.filesDir, "paper-new-conversation.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) } }
                    finally { bitmap.recycle() }
                }
            }
        }
    }

    @Test fun rapidInputSurvivesActivityRecreationWithoutAnOlderRestoreReplacingIt() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("fixture", true)).use { scenario ->
            clickText("新任务")
            repeat(3) { attempt ->
                val value = "切换页面保留输入😀-${java.util.UUID.randomUUID()}-$attempt"
                waitFor { var enabled = false; scenario.onActivity { enabled = it.findViewById<EditText>(MainActivity.INPUT_ID)?.isEnabled == true }; enabled }
                scenario.onActivity { activity ->
                    val composer = activity.findViewById<EditText>(MainActivity.INPUT_ID)
                    repeat(25) { composer.setText("输入中-$it") }
                    composer.setText(value)
                }
                scenario.recreate()
                waitFor { var matches = false; scenario.onActivity { matches = it.findViewById<EditText>(MainActivity.INPUT_ID)?.text?.toString() == value }; matches }
            }
        }
    }
    @Test fun executionSelectionSurvivesEditingAndRecreationAndRequiresFullAccessConfirmation() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val partition = "fixture:service:profile:generation:device"
        LocalStore(context).use { store ->
            store.edit(partition, "global", JSONObject().put("content", MobileContentAdapter.textContent("保留这份输入"))
                .put("executionConfig", JSONObject().put("executionProfile", "read_only").put("approvalPolicy", "policy")))
        }
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("fixture", true)).use { scenario ->
            MobileUiTestDriver.openDrafts(); MobileUiTestDriver.clickContaining("保留这份输入"); clickText("继续编辑")
            fun mode(): String = LocalStore(context).use { store ->
                app.uselexora.mobile.protocol.ExecutionSettings.label(store.draft(partition, "global")!!.value.getJSONObject("executionConfig"))
            }
            fun open() { MobileUiTestDriver.openExecution() }
            waitFor { mode() == "本机只读" }
            open()
            clickText("人工审批")
            waitFor { mode() == "人工审批" }
            scenario.onActivity { it.findViewById<EditText>(MainActivity.INPUT_ID).setText("选择执行方式后的新输入😀") }
            scenario.recreate()
            waitFor { mode() == "人工审批" }
            scenario.onActivity { assertEquals("选择执行方式后的新输入😀", it.findViewById<EditText>(MainActivity.INPUT_ID)?.text?.toString()) }
            open()
            clickText("完全访问")
            clickText("取消")
            clickText("关闭")
            waitFor { mode() == "人工审批" }
            LocalStore(context).use { store ->
                assertEquals("manual", store.draft(partition, "global")!!.value.getJSONObject("executionConfig").getString("approvalPolicy"))
            }
            open()
            clickText("完全访问")
            clickText("允许完全访问")
            waitFor { mode() == "完全访问" }
            scenario.recreate()
            waitFor { mode() == "完全访问" }
            LocalStore(context).use { store ->
                assertEquals("full_access", store.draft(partition, "global")!!.value.getJSONObject("executionConfig").getString("executionProfile"))
            }
        }
    }
    @Test fun recoveryRestoresAttachmentOnlyDraftAndCopiesForeignTextWithoutOverwritingCurrentInput() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val owner = "fixture:service:profile:generation:device"
        val token = java.util.UUID.randomUUID().toString()
        val ownScope = "draft:$token"
        val foreign = "foreign-$token"
        val attachment = "attachment-$token"
        LocalStore(context).use { store ->
            store.edit(owner, "global", JSONObject().put("content", MobileContentAdapter.textContent("当前输入-$token")))
            store.edit(owner, ownScope, JSONObject().put("content", MobileContentAdapter.textContent("").apply { getJSONArray("panelResourceIds").put(attachment) })
                .put("modelSelection", JSONObject().put("providerId", "provider").put("modelId", "model"))
                .put("executionConfig", JSONObject().put("executionProfile", "read_only").put("approvalPolicy", "policy")))
            store.edit(foreign, "global", JSONObject().put("content", MobileContentAdapter.textContent("旧连接输入-$token").apply { getJSONArray("panelResourceIds").put("foreign-attachment") }))
        }
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("fixture", true)).use { scenario ->
            MobileUiTestDriver.openDrafts(); MobileUiTestDriver.clickContaining("当前连接 · 新任务草稿\n1 个附件"); clickText("继续编辑")
            clickText("任务设置")
            waitFor { MobileUiTestDriver.exists("本机只读") }
            clickText("返回对话")
            waitFor { !MobileUiTestDriver.existsTag("conversation-settings") }
            scenario.recreate()
            clickText("任务设置")
            waitFor { MobileUiTestDriver.exists("本机只读") }
            clickText("返回对话")
            waitFor { !MobileUiTestDriver.existsTag("conversation-settings") }
            MobileUiTestDriver.openDrafts(); MobileUiTestDriver.clickContaining("旧连接输入-$token")
            assertFalse(MobileUiTestDriver.exists("继续编辑"))
            clickText("复制文字")
            waitFor { var ready = false; scenario.onActivity { ready = it.findViewById<EditText>(MainActivity.INPUT_ID)?.text?.toString() == "旧连接输入-$token" }; ready }
            LocalStore(context).use { store ->
                assertEquals("当前输入-$token", MobileContentAdapter.text(store.draft(owner, "global")!!.value.getJSONObject("content")))
                val own = store.draft(owner, ownScope)!!.value
                assertEquals(attachment, own.getJSONObject("content").getJSONArray("panelResourceIds").getString(0))
                assertEquals("model", own.getJSONObject("modelSelection").getString("modelId"))
                val copy = store.drafts().single { it.partition == owner && MobileContentAdapter.text(it.value.getJSONObject("content")) == "旧连接输入-$token" }
                assertTrue(copy.scope.startsWith("draft:"))
                assertEquals(0, copy.value.getJSONObject("content").getJSONArray("panelResourceIds").length())
                assertFalse(copy.value.has("draftId")); assertFalse(copy.value.has("revision"))
                assertNotNull(store.draft(foreign, "global"))
            }
        }
    }
}
