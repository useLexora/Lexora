package app.uselexora.mobile

import android.content.Intent
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.ui.ApprovalDialog
import app.uselexora.mobile.ui.MainActivity
import org.json.JSONObject
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.time.Instant
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class ApprovalUiInstrumentedTest {
    @Test fun structuredReviewRetainsAllArgumentsAndNeverApprovesAfterExpiryOrDisconnection() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val now = Instant.parse("2035-01-01T00:00:00Z")
        val current = AtomicReference<Instant?>(now)
        val decision = AtomicReference<String?>(null)
        val body = JSONObject().put("kind", "shell").put("toolName", "shell").put("arguments", JSONObject().put("command", "printf '中文😀'"))
        val approval = JSONObject().put("summary", "运行待审阅命令").put("kind", "shell").put("runId", "run-fixture").put("status", "pending")
            .put("review", JSONObject().put("contentVersion", 1).put("complete", true).put("persistentEffect", false).put("localManagementRequired", false)
                .put("expiresAt", now.plusSeconds(60).toString()).put("reviewVersion", "a".repeat(64)).put("allowedDecisions", JSONArray(listOf("approved", "denied")))
                .put("document", JSONObject().put("format", "json").put("text", body.toString())))
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("fixture", true)).use { scenario ->
            var session: ApprovalDialog.Session? = null
            fun open() = scenario.onActivity { session?.close(); session = ApprovalDialog.show(it, approval, { current.get() ?: error("Disconnected") }, { result -> decision.set(result) }, taskTitle = "整理本周笔记") }
            open()
            waitFor { text("操作参数") && text("printf '中文😀'") }
            assertTrue(text("整理本周笔记")); assertFalse(text("run-fixture")); assertFalse(text("a".repeat(64)))
            click("技术详情"); waitFor { text("run-fixture") && text("a".repeat(64)) }; click("关闭")
            capture("approval-review.png")
            click("仅本次允许")
            assertEquals("approved", decision.getAndSet(null))
            approval.getJSONObject("review").put("persistentEffect", true)
            open(); waitFor { text("需要在桌面端处理") }
            assertFalse(text("仅本次允许")); click("拒绝"); assertEquals("denied", decision.getAndSet(null))
            approval.getJSONObject("review").put("persistentEffect", false)
            open(); waitFor { text("仅本次允许") }
            current.set(now.plusSeconds(61)); click("仅本次允许")
            waitFor { text("连接或审阅已失效，请重新打开此审批。") }; assertNull(decision.get()); click("关闭")
            current.set(now); open(); waitFor { text("仅本次允许") }; current.set(null); click("拒绝")
            waitFor { text("连接或审阅已失效，请重新打开此审批。") }; assertNull(decision.get()); click("关闭")
            current.set(now); open(); waitFor { text("仅本次允许") }
            scenario.onActivity { session!!.update(JSONObject(approval.toString()).put("status", "denied").put("resolution", "denied").put("resolvedAt", now.toString())) }
            waitFor { text("已拒绝") }; assertFalse(text("仅本次允许")); assertNull(decision.get())
            current.set(now); open()
            scenario.onActivity { session!!.setSynchronized(false) }
            waitFor { text("正在核对审批状态") }; assertFalse(text("仅本次允许"))
            scenario.onActivity { session!!.setSynchronized(true) }
            waitFor { text("仅本次允许") }
            scenario.onActivity { session!!.update(JSONObject(approval.toString()).also { it.getJSONObject("review").put("reviewVersion", "b".repeat(64)) }) }
            waitFor { text("审批内容已变化") }; assertFalse(text("仅本次允许"))
            approval.getJSONObject("review").put("expiresAt", now.plusMillis(800).toString())
            val elapsed = SystemClock.elapsedRealtime()
            scenario.onActivity { session!!.close(); session = ApprovalDialog.show(it, approval, { now.plusMillis(SystemClock.elapsedRealtime() - elapsed) }, { result -> decision.set(result) }) }
            waitFor { text("此审批已到期") }; assertFalse(text("仅本次允许")); assertNull(decision.get())
            approval.getJSONObject("review").put("expiresAt", now.plusSeconds(60).toString())
            current.set(now)
            body.put("unknownPermission", true); approval.getJSONObject("review").getJSONObject("document").put("text", body.toString())
            open()
            assertFalse(text("仅本次允许")); click("拒绝"); assertEquals("denied", decision.get())
        }
    }
    private fun text(value: String) = MobileUiTestDriver.contains(value)
    private fun click(value: String) = MobileUiTestDriver.click(value)
    private fun capture(name: String) {
        if (InstrumentationRegistry.getArguments().getString("captureScreenshots") != "true") return
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.waitForIdle(300, 5000)
        instrumentation.uiAutomation.takeScreenshot()?.let { bitmap -> java.io.File(instrumentation.targetContext.externalCacheDir, name).outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
    }
    private fun waitFor(condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 10000
        while (SystemClock.uptimeMillis() < deadline) { if (condition()) return; SystemClock.sleep(30) }
        if (!condition()) MobileUiTestDriver.fail("Approval did not reach its expected state")
    }
}
