package app.uselexora.mobile

import app.uselexora.mobile.protocol.DraftContext
import app.uselexora.mobile.protocol.MobileContentAdapter
import android.content.Intent
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.ui.MainActivity
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.TransferStore
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
        val current = DraftContext.newTaskKey(null)
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
                MobileUiTestDriver.openUnassignedNewTask()
                waitFor { ready() }
                scenario.onActivity { it.findViewById<EditText>(MainActivity.INPUT_ID).setText(latest) }
                clickText("返回")
                MobileUiTestDriver.openUnassignedNewTask()
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
        val scope = DraftContext.newTaskKey(null)
        LocalStore(context).use { store ->
            store.edit(partition, scope, JSONObject().put("content", MobileContentAdapter.textContent("保留这份输入"))
                .put("executionConfig", JSONObject().put("executionProfile", "read_only").put("approvalPolicy", "policy")))
        }
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("fixture", true)).use { scenario ->
            MobileUiTestDriver.openUnassignedNewTask()
            waitFor { MobileUiTestDriver.composerText() == "保留这份输入" }
            fun mode(): String = LocalStore(context).use { store ->
                app.uselexora.mobile.protocol.ExecutionSettings.label(store.draft(partition, scope)!!.value.getJSONObject("executionConfig"))
            }
            fun open() = MobileUiTestDriver.clickTag("composer-permission")
            waitFor { mode() == "本机只读" }
            open()
            clickText("人工审批")
            waitFor { mode() == "人工审批" }
            scenario.onActivity { it.findViewById<EditText>(MainActivity.INPUT_ID).setText("选择执行方式后的新输入😀") }
            scenario.recreate()
            waitFor { mode() == "人工审批" }
            waitFor { MobileUiTestDriver.composerText() == "选择执行方式后的新输入😀" }
            open()
            clickText("完全访问")
            clickText("取消")
            clickText("关闭")
            waitFor { mode() == "人工审批" }
            LocalStore(context).use { store ->
                assertEquals("manual", store.draft(partition, scope)!!.value.getJSONObject("executionConfig").getString("approvalPolicy"))
            }
            open()
            clickText("完全访问")
            clickText("允许完全访问")
            waitFor { mode() == "完全访问" }
            scenario.recreate()
            waitFor { mode() == "完全访问" }
            LocalStore(context).use { store ->
                assertEquals("full_access", store.draft(partition, scope)!!.value.getJSONObject("executionConfig").getString("executionProfile"))
            }
        }
    }
    @Test fun switchingTasksRestoresBranchTextAndUnfinishedAttachmentOnlyToItsOwner() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val owner = "fixture:service:profile:generation:device"
        val firstTask = 999
        val secondTask = 998
        fun branch(number: Int) = "conversation:task-$number:branch-$number"
        val first = branch(firstTask)
        val second = branch(secondTask)
        val token = java.util.UUID.randomUUID().toString()
        val foreign = "foreign-$token"
        val sibling = "conversation:task-$firstTask:other-$token"
        val name = "pending-$token.txt"
        val firstText = "第一份输入😀 $token"
        val secondText = "第二份输入 $token"
        val driver = MobileUiTestDriver
        fun value(text: String) = JSONObject().put("content", MobileContentAdapter.textContent(text))
        LocalStore(context).use { store -> TransferStore(context).use { transfers ->
            val original = store.edit(owner, first, value("").put("modelSelection", JSONObject().put("providerId", "provider").put("modelId", "model"))
                .put("executionConfig", JSONObject().put("executionProfile", "read_only").put("approvalPolicy", "policy")))
            val inputId = original.value.getString("inputId")
            store.edit(owner, second, value(secondText))
            val otherBranch = store.edit(owner, sibling, value("未选择的分支 $token"))
            val otherOwner = store.edit(foreign, first, value("其他服务 $token"))
            val commands = store.outbox(owner).map { it.id }
            val source = java.io.File(java.io.File(context.filesDir, "staging").apply { mkdirs() }, token)
            try {
                source.writeText(firstText)
                transfers.save(JSONObject().put("partition", owner).put("scope", first).put("inputId", inputId)
                    .put("id", token).put("kind", "upload").put("state", "staged").put("path", source.absolutePath)
                    .put("file", JSONObject().put("name", name).put("mimeType", "text/plain").put("sizeBytes", source.length())))
                ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("fixture", true)).use { scenario ->
                    fun open(number: Int) = driver.openTask("任务 $number · 中文输入与恢复 😀")
                    fun awaitFirst(text: String) = waitFor {
                        driver.composerText() == text && driver.contains(name) && driver.contains("上传未完成")
                    }
                    open(firstTask)
                    awaitFirst("")
                    driver.setComposerText(firstText)
                    open(secondTask)
                    waitFor { driver.composerText() == secondText }
                    assertFalse(driver.contains(name))
                    open(firstTask)
                    awaitFirst(firstText)
                    scenario.recreate()
                    awaitFirst(firstText)
                    assertFalse(driver.exists("移除附件 $name"))
                    val restored = store.draft(owner, first)!!.value
                    assertEquals(inputId, restored.getString("inputId"))
                    assertEquals(0, restored.getJSONObject("content").getJSONArray("panelResourceIds").length())
                    assertEquals("model", restored.getJSONObject("modelSelection").getString("modelId"))
                    assertEquals("read_only", restored.getJSONObject("executionConfig").getString("executionProfile"))
                    assertEquals(secondText, MobileContentAdapter.text(store.draft(owner, second)!!.value.getJSONObject("content")))
                    assertEquals(otherBranch.value.toString(), store.draft(owner, sibling)!!.value.toString())
                    assertEquals(otherOwner.value.toString(), store.draft(foreign, first)!!.value.toString())
                    assertEquals("staged", transfers.get(token)!!.getString("state"))
                    assertEquals(firstText, source.readText())
                    assertEquals(commands, store.outbox(owner).map { it.id })
                }
            } finally {
                for ((partition, scope) in listOf(owner to first, owner to second, owner to sibling, foreign to first))
                    store.writableDatabase.delete("drafts", "partition=? AND scope=?", arrayOf(partition, scope))
                transfers.writableDatabase.delete("transfers", "partition=? AND id=?", arrayOf(owner, token))
                source.delete()
            }
        } }
    }
}
