package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import android.content.Intent
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.protocol.CommandOutbox
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.ui.MainActivity
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class HistoryInstrumentedTest {
    @Test fun restoredHistoryInputsForkFromTheirExactSourcesWithoutChangingOriginalBranches() {
        val token = InstrumentationRegistry.getArguments().getString("historyToken")
        assumeTrue(token?.matches(Regex("[a-f0-9-]{36}")) == true)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val config = JSONObject(ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand("cat /data/local/tmp/lexora-history-$token.json")).bufferedReader().use { it.readText() })
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val connection = MobileConnection(context, schemas, BuildConfig.VERSION_NAME)
        connection.pair(config.getJSONObject("pairing").toString())
        val client = connection.connect()!!
        val partition = client.identity!!.partition
        val conversationId = config.getString("conversationId")
        val originalBranch = config.getString("originalBranchId")
        fun marker(stage: String) = File(context.filesDir, "history-$token-$stage.json")
        fun signal(stage: String, value: JSONObject = JSONObject()) { marker(stage).writeText(value.toString()) }
        fun awaitSignal(stage: String) = waitFor(60000) { marker(stage).isFile }
        fun task() = client.call("conversations.get", JSONObject().put("conversationId", conversationId))
        fun messages(branchId: String) = client.call("conversations.listMessages", JSONObject().put("conversationId", conversationId).put("branchId", branchId)).getJSONArray("items").let { values -> (0 until values.length()).map { values.getJSONObject(it) } }
        fun released(id: String) = client.call("runs.getExecutionState", JSONObject().put("runId", id)).getString("resources") == "released"
        try { LocalStore(context).use { store ->
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
                fun input(value: String) { scenario.onActivity { it.findViewById<EditText>(MainActivity.INPUT_ID).setText(value) } }
                fun inputIs(value: String): Boolean { var actual = ""; scenario.onActivity { actual = it.findViewById<EditText>(MainActivity.INPUT_ID)?.text?.toString().orEmpty() }; return actual == value }
                waitFor { MobileUiTestDriver.connected() }
                MobileUiTestDriver.openTask(task().getString("title"))
                waitFor { text("历史回复 2") }
                input("原分支保留输入")
                val originalScope = "conversation:$conversationId:$originalBranch"
                waitFor { store.draft(partition, originalScope)?.value?.getJSONObject("content")?.let { MobileContentAdapter.text(it) } == "原分支保留输入" }
                val source = messages(originalBranch).single { it.optString("role") == "assistant" && it.getJSONObject("body").optString("text").contains("历史回复 1") }
                longClickContaining("历史回复 1"); click("从这里继续")
                waitFor { text("接续选中的历史回复") && inputIs("") }
                input("从第一条回复继续 😀")
                val followupScope = "message-followup:$conversationId:$originalBranch:${source.getString("id")}"
                waitFor { store.draft(partition, followupScope)?.value?.getJSONObject("content")?.let { MobileContentAdapter.text(it) } == "从第一条回复继续 😀" }
                val before = store.outbox(partition).size
                scenario.recreate()
                waitFor { MobileUiTestDriver.enabled("发送") && text("接续选中的历史回复") && inputIs("从第一条回复继续 😀") }
                assertEquals(before, store.outbox(partition).size)
                click("发送")
                waitFor { text("历史回复 3") }
                val followup = store.outbox(partition).single { it.method == "chat.submitInput" && it.envelope.getJSONObject("intent").getString("operation") == "start" }.receipt!!
                val followupTarget = followup.getJSONObject("target")
                assertNotEquals(originalBranch, followupTarget.getString("branchId"))
                waitFor { released(followupTarget.getString("runId")) }
                longClickContaining("从第一条回复继续"); click("编辑")
                waitFor { text("正在编辑历史输入") && inputIs("从第一条回复继续 😀") }
                input("编辑后的接续输入 😀")
                scenario.recreate()
                waitFor { MobileUiTestDriver.enabled("发送") && text("正在编辑历史输入") && inputIs("编辑后的接续输入 😀") }
                click("发送")
                waitFor { text("历史回复 4") }
                val edited = store.outbox(partition).single { it.method == "chat.submitInput" && it.envelope.getJSONObject("intent").getString("operation") == "edit" }.receipt!!
                val editTarget = edited.getJSONObject("target")
                assertNotEquals(followupTarget.getString("branchId"), editTarget.getString("branchId"))
                waitFor { released(editTarget.getString("runId")) }
                assertTrue(messages(followupTarget.getString("branchId")).any { it.getJSONObject("body").optString("kind") == "user" && MobileContentAdapter.text(it.getJSONObject("body").getJSONObject("content")) == "从第一条回复继续 😀" })
                longClickContaining("历史回复 4"); click("运行详情")
                waitFor { text("服务资源：已释放") }
                click("重新生成"); waitFor { text("重新生成此次回复？") }; click("重新生成")
                waitFor { text("历史回复 5") }
                val regeneration = store.outbox(partition).single { it.method == "chat.regenerateAssistant" }
                val regenerated = regeneration.receipt!!
                assertEquals(regenerated.toString(), CommandOutbox(store).retry(client, regeneration).toString())
                val regeneratedTarget = regenerated.getJSONObject("target")
                waitFor { released(regeneratedTarget.getString("runId")) }
                assertNotEquals(editTarget.getString("branchId"), regeneratedTarget.getString("branchId"))
                signal("regenerated", regeneratedTarget)
                awaitSignal("original-active")
                waitFor { task().getString("activeBranchId") == originalBranch }
                MobileUiTestDriver.openTaskSettings(); click("刷新任务"); MobileUiTestDriver.returnToConversation()
                waitFor { text("历史回复 5") && inputIs("") }
                MobileUiTestDriver.selectBranch(originalBranch)
                waitFor { text("历史回复 2") && inputIs("原分支保留输入") }
                val preserved = listOf(originalBranch, followupTarget.getString("branchId"), editTarget.getString("branchId"), regeneratedTarget.getString("branchId")).associateWith { branch -> messages(branch).map { it.toString() } }
                longClickContaining("后续输入不应进入历史续写"); click("编辑")
                waitFor { inputIs("后续输入不应进入历史续写") }
                input("默认分支改变仍从原来源编辑")
                signal("source-edit-ready")
                awaitSignal("branch-changed")
                waitFor { task().getString("activeBranchId") == regeneratedTarget.getString("branchId") }
                click("发送")
                waitFor { text("历史回复 6") }
                val independentEdit = store.outbox(partition).filter { it.method == "chat.submitInput" && it.envelope.getJSONObject("intent").getString("operation") == "edit" && it.state == "accepted" }.first { it.receipt!!.getJSONObject("target").getString("branchId") != editTarget.getString("branchId") }
                val independentTarget = independentEdit.receipt!!.getJSONObject("target")
                assertNotEquals(originalBranch, independentTarget.getString("branchId"))
                assertNotEquals(regeneratedTarget.getString("branchId"), independentTarget.getString("branchId"))
                waitFor { released(independentTarget.getString("runId")) }
                preserved.forEach { (branch, snapshot) -> assertEquals(snapshot, messages(branch).map { it.toString() }) }
                assertEquals("原分支保留输入", MobileContentAdapter.text(store.draft(partition, originalScope)!!.value.getJSONObject("content")))
                longClickContaining("默认分支改变仍从原来源编辑"); click("编辑")
                waitFor { inputIs("默认分支改变仍从原来源编辑") }
                input("任务已删除时必须保留的编辑")
                signal("delete-ready", independentTarget)
                awaitSignal("task-deleted")
                click("发送")
                waitFor { store.outbox(partition).any { it.method == "chat.submitInput" && it.envelope.getJSONObject("intent").getString("operation") == "edit" && it.state == "rejected" } }
                assertTrue(inputIs("任务已删除时必须保留的编辑"))
                val rejection = store.outbox(partition).single { it.method == "chat.submitInput" && it.envelope.getJSONObject("intent").getString("operation") == "edit" && it.state == "rejected" }
                assertEquals("SOURCE_CHANGED", rejection.receipt!!.getString("errorCode"))
                assertEquals(rejection.receipt.toString(), CommandOutbox(store).retry(client, rejection).toString())
                assertEquals("原分支保留输入", MobileContentAdapter.text(store.draft(partition, originalScope)!!.value.getJSONObject("content")))
                signal("done", JSONObject().put("sourceMessageId", source.getString("id")).put("followup", followupTarget).put("edit", editTarget).put("regenerate", regeneratedTarget).put("independentEdit", independentTarget).put("deletedSourceRejection", rejection.receipt).put("originalInputPreserved", true).put("recreationPreservesTarget", true).put("independentBranchEditAccepted", true))
                instrumentation.uiAutomation.waitForIdle(300, 5000)
                instrumentation.uiAutomation.takeScreenshot()?.let { bitmap -> File(context.filesDir, "history-$token-branches.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
            }
        } } finally { client.close(); connection.description()?.let { connection.logout(it) } }
    }
    private fun text(value: String) = MobileUiTestDriver.contains(value)
    private fun click(value: String) = MobileUiTestDriver.click(value)
    private fun longClickContaining(value: String) = MobileUiTestDriver.longClick(value)
    private fun waitFor(timeout: Long = 20000, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeout
        while (SystemClock.uptimeMillis() < deadline) { if (condition()) return; SystemClock.sleep(50) }
        fun labels(node: AccessibilityNodeInfo?): List<String> = if (node == null) emptyList() else listOfNotNull(node.text?.toString()) + (0 until node.childCount).flatMap { labels(node.getChild(it)) }
        if (!condition()) MobileUiTestDriver.fail("History workflow did not converge: ${labels(InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow)}")
    }
}
