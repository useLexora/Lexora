package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import android.content.Intent
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.EditText
import androidx.lifecycle.Lifecycle
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
class TaskControlsInstrumentedTest {
    @Test fun queueControlsKeepExactTargetsAndReadStateConvergesAcrossClients() {
        val token = InstrumentationRegistry.getArguments().getString("taskControlsToken")
        assumeTrue(token?.matches(Regex("[a-f0-9-]{36}")) == true)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val config = JSONObject(ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand("cat /data/local/tmp/lexora-controls-$token.json")).bufferedReader().use { it.readText() })
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val connection = MobileConnection(context, schemas, BuildConfig.VERSION_NAME)
        connection.pair(config.getJSONObject("pairing").toString())
        val client = connection.connect()!!
        val partition = client.identity!!.partition
        fun marker(stage: String) = File(context.filesDir, "controls-$token-$stage.json")
        fun signal(stage: String, value: JSONObject = JSONObject()) { marker(stage).writeText(value.toString()) }
        fun awaitSignal(stage: String) = waitFor(60000) { marker(stage).isFile }
        val task = client.call("conversations.get", JSONObject().put("conversationId", config.getString("conversationId")))
        val target = JSONObject().put("conversationId", task.getString("id")).put("branchId", task.getString("activeBranchId"))
        fun queue() = client.call("chat.queue.list", target).getJSONArray("items").let { items -> (0 until items.length()).map { items.getJSONObject(it) } }
        fun execution(id: String) = client.call("runs.getExecutionState", JSONObject().put("runId", id))
        fun marks() = (client.callValue("taskMarks.states", JSONObject().put("conversationIds", org.json.JSONArray().put(task.getString("id")))) as org.json.JSONArray).getJSONObject(0)
        try { LocalStore(context).use { store ->
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
                MobileUiTestDriver.awaitConnected()
                MobileUiTestDriver.openTask(task.getString("title"))
                fun enqueue(value: String): JSONObject {
                    MobileUiTestDriver.returnToConversation()
                    scenario.onActivity { it.findViewById<EditText>(MainActivity.INPUT_ID).setText(value) }
                    MobileUiTestDriver.enqueueInput()
                    waitFor { queue().any { MobileContentAdapter.text(it.getJSONObject("content")) == value } }
                    return queue().single { MobileContentAdapter.text(it.getJSONObject("content")) == value }
                }
                fun openQueue(value: String) { MobileUiTestDriver.openTaskSettings(); click("待发送队列"); clickContaining(" · $value") }
                val removable = enqueue("手机撤回输入 😀")
                openQueue("手机撤回输入 😀"); click("移除此条输入")
                waitFor { queue().none { it.getString("id") == removable.getString("id") } }
                val stale = enqueue("双方竞争撤回")
                openQueue("双方竞争撤回")
                signal("stale-ready", stale)
                awaitSignal("stale-removed")
                click("移除此条输入")
                MobileUiTestDriver.returnToConversation()
                waitFor { text("队列已变化") }
                scenario.moveToState(Lifecycle.State.CREATED)
                scenario.moveToState(Lifecycle.State.RESUMED)
                MobileUiTestDriver.openTaskSettings(); MobileUiTestDriver.awaitConnected(); MobileUiTestDriver.returnToConversation()
                assertTrue(text("队列已变化"))
                val rejection = store.outbox(partition).single { it.method == "chat.queue.cancel" && it.envelope.getJSONObject("intent").getString("id") == stale.getString("id") }
                assertEquals("QUEUE_CHANGED", rejection.receipt!!.getString("errorCode"))
                assertEquals(rejection.receipt.toString(), CommandOutbox(store).retry(client, rejection).toString())
                val steering = enqueue("手机补充当前执行")
                val originalRun = steering.getJSONObject("steerTarget").getString("runId")
                openQueue("手机补充当前执行"); click("发送给此时的运行")
                waitFor { text("补充请求已受理") }; click("关闭")
                waitFor { queue().none { it.getString("id") == steering.getString("id") } }
                signal("steered", JSONObject().put("runId", originalRun))
                awaitSignal("steer-delivered")
                assertEquals("running", client.call("runs.get", JSONObject().put("runId", originalRun)).getString("status"))
                val paused = enqueue("明确继续后才执行")
                val retainedInput = "停止时保留当前输入😀 $token"
                val originalScope = "conversation:${task.getString("id")}:${task.getString("activeBranchId")}"
                fun input(): String {
                    var value = ""
                    scenario.onActivity { value = it.findViewById<EditText>(MainActivity.INPUT_ID)?.text?.toString().orEmpty() }
                    return value
                }
                fun write(value: String, scope: String) {
                    scenario.onActivity { it.findViewById<EditText>(MainActivity.INPUT_ID).setText(value) }
                    waitFor { store.draft(partition, scope)?.value?.optJSONObject("content")?.let(MobileContentAdapter::text) == value }
                }
                write(retainedInput, originalScope)
                MobileUiTestDriver.stopRunningReply()
                waitFor { client.call("runs.get", JSONObject().put("runId", originalRun)).getString("status") == "cancelled" && execution(originalRun).getString("resources") == "released" }
                waitFor { text("任务设置") && !MobileUiTestDriver.exists("停止回复") }
                assertEquals(retainedInput, input())
                assertFalse(text("本次运行"))
                capture("controls-$token-stopped.png")
                waitFor { queue().any { it.getString("id") == paused.getString("id") && it.getString("state") == "paused" } }
                signal("paused", JSONObject().put("runId", originalRun).put("queueId", paused.getString("id")))
                awaitSignal("continue")
                openQueue("明确继续后才执行"); click("继续此条输入")
                waitFor { store.outbox(partition).any { it.method == "chat.queue.continue" && it.receipt?.optString("decision") == "accepted" } }
                val continuation = store.outbox(partition).single { it.method == "chat.queue.continue" }
                val nextRun = continuation.receipt!!.getJSONObject("target").getString("runId")
                assertNotEquals(originalRun, nextRun)
                awaitSignal("next-running")
                val stop = store.outbox(partition).single { it.method == "chat.cancel" }
                assertEquals(stop.receipt.toString(), CommandOutbox(store).retry(client, stop).toString())
                val lateStop = CommandOutbox(store).submit(client, "chat.cancel", JSONObject(stop.envelope.getJSONObject("intent").toString()))
                assertEquals("rejected", lateStop.getString("decision"))
                assertEquals("SOURCE_CHANGED", lateStop.getString("errorCode"))
                assertEquals("running", client.call("runs.get", JSONObject().put("runId", nextRun)).getString("status"))
                signal("old-stop-replayed", JSONObject().put("nextRunId", nextRun).put("receipt", stop.receipt))
                MobileUiTestDriver.returnToConversation()
                waitFor { text("恢复排队任务完成") }
                waitFor { execution(nextRun).getString("resources") == "released" }
                waitFor { !marks().getBoolean("unread") }
                MobileUiTestDriver.openTaskSettings(); click("已读状态"); click("标为未读")
                waitFor { marks().getBoolean("unread") }
                MobileUiTestDriver.returnToConversation()
                val manualUnread = store.outbox(partition).size
                val observeUntil = SystemClock.uptimeMillis() + 600
                while (SystemClock.uptimeMillis() < observeUntil) {
                    assertTrue(marks().getBoolean("unread"))
                    assertEquals(manualUnread, store.outbox(partition).size)
                    SystemClock.sleep(50)
                }
                MobileUiTestDriver.openTaskSettings(); click("已读状态"); click("标为已读")
                waitFor { !marks().getBoolean("unread") }
                signal("phone-read", marks())
                awaitSignal("desktop-unread")
                MobileUiTestDriver.openTaskSettings(); click("已读状态"); waitFor { text("此任务有未读结果") }; click("关闭")
                val before = store.outbox(partition).size
                scenario.moveToState(Lifecycle.State.CREATED)
                signal("background")
                awaitSignal("desktop-read")
                scenario.moveToState(Lifecycle.State.RESUMED)
                MobileUiTestDriver.awaitConnected()
                MobileUiTestDriver.openTaskSettings(); click("已读状态"); waitFor { text("此任务已读") }; click("关闭")
                assertEquals(before, store.outbox(partition).size)
                MobileUiTestDriver.returnToConversation()
                val originalInput = "原始分支未发送输入😀 $token"
                val forkInput = "历史分支未发送输入😀 $token"
                write(originalInput, originalScope)
                signal("branches-ready")
                awaitSignal("branches-created")
                val branchPage = client.call("conversations.listBranches", JSONObject().put("conversationId", task.getString("id")))
                val branches = branchPage.getJSONArray("items")
                assertEquals(2, branches.length())
                val fork = (0 until branches.length()).map { branches.getJSONObject(it) }.single { it.getString("id") != task.getString("activeBranchId") }
                val forkId = fork.getString("id")
                val forkScope = "conversation:${task.getString("id")}:$forkId"
                val defaultBranch = client.call("conversations.get", JSONObject().put("conversationId", task.getString("id"))).getString("activeBranchId")
                val submittedInputs = store.outbox(partition).filter { it.method == "chat.submitInput" }.map { it.id }.toSet()
                fun switchBranch(expectedId: String, expectedInput: String) {
                    val priorCommands = store.outbox(partition).filter { it.method != "taskMarks.setRead" }.map { it.id }
                    MobileUiTestDriver.selectBranch(expectedId)
                    waitFor { input() == expectedInput && MobileUiTestDriver.exists("任务设置") }
                    assertEquals(priorCommands, store.outbox(partition).filter { it.method != "taskMarks.setRead" }.map { it.id })
                    assertEquals(defaultBranch, client.call("conversations.get", JSONObject().put("conversationId", task.getString("id"))).getString("activeBranchId"))
                }
                switchBranch(forkId, "")
                write(forkInput, forkScope)
                switchBranch(task.getString("activeBranchId"), originalInput)
                assertEquals(forkInput, MobileContentAdapter.text(store.draft(partition, forkScope)!!.value.getJSONObject("content")))
                switchBranch(forkId, forkInput)
                scenario.recreate()
                waitFor { input() == forkInput && MobileUiTestDriver.enabled("发送") }
                switchBranch(task.getString("activeBranchId"), originalInput)
                assertEquals(originalInput, MobileContentAdapter.text(store.draft(partition, originalScope)!!.value.getJSONObject("content")))
                assertEquals(forkInput, MobileContentAdapter.text(store.draft(partition, forkScope)!!.value.getJSONObject("content")))
                assertEquals(submittedInputs, store.outbox(partition).filter { it.method == "chat.submitInput" }.map { it.id }.toSet())
                assertEquals(0, store.outbox(partition).count { it.method == "conversations.activateBranch" })
                signal("done", JSONObject().put("directStopRetainedInput", true).put("branchDraftIsolation", true).put("forkBranchId", forkId).put("originalBranchId", task.getString("activeBranchId")).put("originalRunId", originalRun).put("nextRunId", nextRun).put("staleQueueRejected", true).put("oldStopReplayed", true).put("automaticVisibleRead", true).put("manualUnreadPreserved", true).put("readState", marks()).put("stopReceipt", stop.receipt))
                capture("controls-$token-final.png")
            }
        } } finally { client.close(); connection.description()?.let { connection.logout(it) } }
    }
    private fun text(value: String) = MobileUiTestDriver.contains(value)
    private fun click(value: String) = MobileUiTestDriver.click(value)
    private fun clickContaining(value: String) = MobileUiTestDriver.clickContaining(value)
    private fun clickStarting(value: String) = MobileUiTestDriver.click(value, prefix = true)
    private fun capture(name: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.waitForIdle(300, 5000)
        instrumentation.uiAutomation.takeScreenshot()?.let { bitmap -> File(instrumentation.targetContext.filesDir, name).outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
    }
    private fun waitFor(timeout: Long = 20000, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeout
        while (SystemClock.uptimeMillis() < deadline) { if (condition()) return; SystemClock.sleep(50) }
        fun labels(node: AccessibilityNodeInfo?): List<String> = if (node == null) emptyList() else listOfNotNull(node.text?.toString()) + (0 until node.childCount).flatMap { labels(node.getChild(it)) }
        if (!condition()) MobileUiTestDriver.fail("Task control state did not converge: ${labels(InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow)}")
    }
}
