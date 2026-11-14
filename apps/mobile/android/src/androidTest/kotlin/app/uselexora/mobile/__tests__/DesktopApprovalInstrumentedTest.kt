package app.uselexora.mobile

import android.content.Intent
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.protocol.CommandOutbox
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.ui.MainActivity
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class DesktopApprovalInstrumentedTest {
    @Test fun bothClientsConvergeOnDecisionsAndCancellationWithoutReplayingOldApprovals() {
        val token = InstrumentationRegistry.getArguments().getString("desktopApprovalToken")
        assumeTrue(token?.matches(Regex("[a-f0-9-]{36}")) == true)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val config = JSONObject(ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand("cat /data/local/tmp/lexora-approval-$token.json")).bufferedReader().use { it.readText() })
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val connection = MobileConnection(context, schemas, BuildConfig.VERSION_NAME)
        connection.pair(config.getJSONObject("pairing").toString())
        var client = connection.connect()!!
        val partition = client.identity!!.partition
        val evidence = JSONArray()
        val seen = mutableSetOf<String>()
        try { LocalStore(context).use { store ->
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
                waitFor { MobileUiTestDriver.connected() }
                val task = client.call("conversations.get", JSONObject().put("conversationId", config.getString("conversationId")))
                MobileUiTestDriver.openTask(task.getString("title"))
                repeat(5) { phase ->
                    var pending: JSONObject? = null
                    waitFor(60000) {
                        val items = client.call("approvals.list", JSONObject().put("conversationId", task.getString("id")).put("status", "pending")).getJSONArray("items")
                        pending = (0 until items.length()).map { items.getJSONObject(it) }.firstOrNull { it.getString("id") !in seen }
                        pending != null
                    }
                    val review = pending!!
                    val id = review.getString("id")
                    seen.add(id)
                    MobileUiTestDriver.openApprovals(); click(review.getString("summary")); waitFor { text("操作参数") }
                    click("选择处理方式"); waitFor { text("仅本次允许") }
                    val before = store.outbox(partition).count { it.method == "approvals.resolve" }
                    val staleTask = if (phase == 3) client.call("conversations.get", JSONObject().put("conversationId", task.getString("id"))) else null
                    File(context.filesDir, "approval-$token-$phase-ready.json").writeText(JSONObject().put("approvalId", id).put("runId", review.getString("runId")).toString())
                    if (phase == 1 || phase == 4) {
                        waitFor(60000) { File(context.filesDir, "approval-$token-$phase-resume.json").isFile }
                        click(if (phase == 1) "仅本次允许" else "拒绝")
                    } else if (phase == 3) {
                        val instance = client.identity!!.serviceInstanceId
                        try { waitFor(45000) { !client.isConnected && !text("仅本次允许") && !text("选择处理方式") } }
                        catch (error: AssertionError) {
                            capture("approval-$token-failure.png")
                            fun labels(node: AccessibilityNodeInfo?): List<String> = if (node == null) emptyList() else listOfNotNull(node.text?.toString()) + (0 until node.childCount).flatMap { labels(node.getChild(it)) }
                            throw AssertionError("connected=${client.isConnected}; UI=${labels(instrumentation.uiAutomation.rootInActiveWindow)}", error)
                        }
                        assertFalse(text("仅本次允许")); assertFalse(text("选择处理方式"))
                        waitFor(60000) { File(context.filesDir, "approval-$token-$phase-resume.json").isFile }
                        client.close(); client = connection.connect()!!
                        assertEquals(partition, client.identity!!.partition)
                        assertNotEquals(instance, client.identity!!.serviceInstanceId)
                        val staleId = store.newId()
                        val stale = JSONObject().put("dataGeneration", client.identity!!.dataGeneration).put("commandId", staleId).put("expectedServiceInstanceId", instance)
                            .put("intent", JSONObject().put("conversationId", task.getString("id")).put("expectedTitleRevision", staleTask!!.getString("titleRevision")).put("title", "旧实例不能改名"))
                        val error = runCatching { client.call("conversations.rename", stale) }.exceptionOrNull()
                        assertTrue(error is ProtocolFailure)
                        assertEquals("SERVICE_INSTANCE_CHANGED", (error as ProtocolFailure).code)
                        assertEquals(staleTask.getString("title"), client.call("conversations.get", JSONObject().put("conversationId", task.getString("id"))).getString("title"))
                        assertEquals("not_found", client.call("commands.get", JSONObject().put("dataGeneration", client.identity!!.dataGeneration).put("commandId", staleId)).getString("lookup"))
                        for (old in store.outbox(partition).filter { it.receipt != null }) {
                            val receipt = client.call("commands.get", JSONObject().put("dataGeneration", client.identity!!.dataGeneration).put("commandId", old.id)).getJSONObject("receipt")
                            assertEquals(old.receipt!!.toString(), receipt.toString())
                        }
                        scenario.moveToState(Lifecycle.State.CREATED)
                        scenario.moveToState(Lifecycle.State.RESUMED)
                        MobileUiTestDriver.awaitConnected()
                        assertFalse(text("选择处理方式"))
                        assertEquals(before, store.outbox(partition).count { it.method == "approvals.resolve" })
                    } else {
                        waitFor { text(if (phase == 0) "已拒绝" else "已取消或失效") }
                        assertFalse(text("仅本次允许")); assertFalse(text("选择处理方式"))
                        assertTrue(text("处理方"))
                        if (phase == 2) assertTrue(text("运行或授权已取消"))
                        capture("approval-$token-$phase.png")
                        assertEquals(before, store.outbox(partition).count { it.method == "approvals.resolve" })
                        if (phase == 2) {
                            scenario.moveToState(Lifecycle.State.CREATED)
                            scenario.moveToState(Lifecycle.State.RESUMED)
                            MobileUiTestDriver.awaitConnected()
                            assertFalse(text("处理此版本的操作")); assertFalse(text("选择处理方式"))
                        } else click("关闭")
                    }
                    val terminal = if (phase == 0 || phase == 4) "denied" else if (phase == 1) "approved" else "cancelled"
                    waitFor { client.call("approvals.get", JSONObject().put("approvalId", id)).getString("status") == terminal }
                    val outcome = client.call("approvals.getDecision", JSONObject().put("approvalId", id))
                    assertEquals(terminal, outcome.getString("status"))
                    if (phase == 0) assertEquals("desktop", outcome.getJSONObject("actor").getString("kind"))
                    if (phase == 1 || phase == 4) assertTrue(outcome.getJSONObject("actor").getBoolean("current"))
                    if (phase == 2) assertEquals("cancelled", outcome.getString("cancellationReason"))
                    if (phase == 3) assertTrue(outcome.getString("cancellationReason") in listOf("shutdown", "recovery", "cancelled"))
                    val outbox = CommandOutbox(store)
                    if (phase != 1 && phase != 4) {
                        val rejected = outbox.submit(client, "approvals.resolve", JSONObject().put("approvalId", id).put("runId", review.getString("runId"))
                            .put("reviewVersion", review.getJSONObject("review").getString("reviewVersion")).put("decision", "approved"))
                        assertEquals("rejected", rejected.getString("decision"))
                        assertEquals("APPROVAL_ALREADY_RESOLVED", rejected.getString("errorCode"))
                        assertEquals(terminal, rejected.getJSONObject("result").getString("status"))
                    }
                    waitFor { store.outbox(partition).count { it.method == "approvals.resolve" } == before + 1 }
                    val own = store.outbox(partition).first { it.method == "approvals.resolve" && it.envelope.getJSONObject("intent").getString("approvalId") == id }
                    waitFor { store.outbox(partition).first { it.id == own.id }.receipt != null }
                    val original = store.outbox(partition).first { it.id == own.id }.receipt!!
                    assertEquals(original.toString(), outbox.retry(client, own).toString())
                    assertEquals(if (phase == 1 || phase == 4) "accepted" else "rejected", original.getString("decision"))
                    MobileUiTestDriver.returnToConversation()
                    if (phase < 2 || phase == 4) MobileUiTestDriver.awaitMessage("双端审批完成 $phase")
                    if (phase == 1 && config.optBoolean("desktopLifecycle")) {
                        MobileUiTestDriver.openTaskSettings(); click("在桌面端打开"); MobileUiTestDriver.returnToConversation()
                        waitFor { text("服务已打开目标页面") }
                        assertTrue(store.outbox(partition).any { it.method == "desktop.open" && it.receipt?.optString("decision") == "accepted" })
                    }
                    evidence.put(JSONObject().put("phase", phase).put("status", terminal).put("receipt", original).put("outcome", outcome).put("oldChoicesRemoved", phase != 1 && phase != 4))
                    File(context.filesDir, "approval-$token-$phase-done.json").writeText(evidence.toString())
                }
                capture("approval-$token-final.png")
                if (config.optBoolean("desktopLifecycle")) {
                    val before = store.outbox(partition).size
                    File(context.filesDir, "approval-$token-final-ready.json").writeText("{}")
                    waitFor(45000) { !client.isConnected && !MobileUiTestDriver.connected() }
                    assertEquals(before, store.outbox(partition).size)
                    File(context.filesDir, "approval-$token-final-done.json").writeText(JSONObject().put("disconnected", true).put("outboxUnchanged", true).toString())
                }
            }
        } } finally { client.close(); connection.description()?.let { if (config.optBoolean("desktopLifecycle")) connection.forget(it) else connection.logout(it) } }
    }
    private fun text(value: String) = MobileUiTestDriver.contains(value)
    private fun click(value: String) = MobileUiTestDriver.click(value)
    private fun capture(name: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.waitForIdle(300, 5000)
        instrumentation.uiAutomation.takeScreenshot()?.let { bitmap -> File(instrumentation.targetContext.filesDir, name).outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
    }
    private fun waitFor(timeout: Long = 20000, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeout
        while (SystemClock.uptimeMillis() < deadline) { if (condition()) return; SystemClock.sleep(50) }
        if (!condition()) MobileUiTestDriver.fail("Desktop and Android approval state did not converge")
    }
}
