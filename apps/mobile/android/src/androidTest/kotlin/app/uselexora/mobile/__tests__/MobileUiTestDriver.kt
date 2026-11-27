package app.uselexora.mobile

import android.graphics.Rect
import android.os.SystemClock
import android.os.ParcelFileDescriptor
import android.view.Choreographer
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityNodeInfo
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import app.uselexora.mobile.ui.MobileAction
import app.uselexora.mobile.ui.MainActivity
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

enum class BranchStep(val label: String) { Previous("上一个分支"), Next("下一个分支") }

object MobileUiTestDriver {
    private val automation get() = InstrumentationRegistry.getInstrumentation().uiAutomation

    fun waitUntil(timeout: Long = 15000, condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + timeout
        while (SystemClock.uptimeMillis() < deadline) {
            if (condition()) return
            SystemClock.sleep(50)
        }
        if (!condition()) fail("Android did not reach the expected visible state")
    }

    fun fail(message: String): Nothing {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val name = "mobile-ui-failure-${System.currentTimeMillis()}"
        val nodes = JSONArray()
        val artifacts = mutableListOf<String>()
        runCatching {
            visit { node ->
                if (node.isVisibleToUser) {
                    val bounds = Rect().apply { node.getBoundsInScreen(this) }
                    nodes.put(JSONObject().put("text", node.text?.toString()).put("description", node.contentDescription?.toString())
                        .put("id", node.viewIdResourceName).put("class", node.className?.toString()).put("bounds", bounds.toShortString())
                        .put("clickable", node.isClickable).put("enabled", node.isEnabled))
                }
                false
            }
            File(context.filesDir, "$name.json").writeText(nodes.toString(2))
            artifacts.add("$name.json")
        }
        runCatching {
            automation.takeScreenshot()?.let { bitmap ->
                try {
                    File(context.filesDir, "$name.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
                    artifacts.add("$name.png")
                } finally { bitmap.recycle() }
            }
        }
        val visible = (0 until nodes.length()).flatMap { index ->
            val node = nodes.getJSONObject(index)
            listOf(node.optString("text"), node.optString("description")).filter { it.isNotBlank() }
        }.joinToString(" | ").take(2400)
        throw AssertionError("$message; files=${artifacts.joinToString()}; visible=$visible")
    }

    fun exists(value: String, prefix: Boolean = false): Boolean = find(value, prefix) != null
    fun contains(value: String): Boolean = visit { node -> visible(node) && listOf(node.text?.toString(), node.contentDescription?.toString()).filterNotNull().any { it.contains(value) } } != null
    fun connected(): Boolean = contains("已连接服务") || (existsTag("conversation-settings") && exists("已连接"))
    fun enabled(value: String): Boolean = find(value)?.let { node ->
        var current: AccessibilityNodeInfo = node
        while (current.refresh() && !current.isClickable && current.isEnabled) current = current.parent ?: break
        current.isClickable && current.isEnabled
    } == true
    fun bounds(value: String, prefix: Boolean = false): Rect? = find(value, prefix)?.let { Rect().apply { it.getBoundsInScreen(this) } }

    fun click(value: String, prefix: Boolean = false) = clickNode(value, prefix)
    fun clickContaining(value: String) = clickNode(value, substring = true)
    fun clickTag(value: String) = clickNode(value, tag = true)
    fun existsTag(value: String) = byId(value)?.isVisibleToUser == true
    fun composerText(): String? = visit { it.isVisibleToUser && it.className?.toString() == "android.widget.EditText" }?.let { if (it.isShowingHintText) "" else it.text?.toString() }
    fun setComposerText(value: String) = waitUntil {
        visit { it.isVisibleToUser && it.className?.toString() == "android.widget.EditText" }
            ?.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, android.os.Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value) }) == true
    }

    fun setTextTag(tag: String, value: String) {
        waitUntil {
            byId(tag)?.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, android.os.Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value) }) == true
        }
    }

    private fun clickNode(value: String, prefix: Boolean = false, substring: Boolean = false, tag: Boolean = false) {
        var forward = true
        var lastScroll = 0L
        waitUntil {
            val node = if (tag) byId(value)?.takeIf { it.isVisibleToUser } else find(value, prefix, substring)
            if (node == null) {
                val now = SystemClock.uptimeMillis()
                if (now - lastScroll >= 200) {
                    val action = if (forward) AccessibilityNodeInfo.ACTION_SCROLL_FORWARD else AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD
                    if (scrollable()?.performAction(action) == false) forward = !forward
                    lastScroll = now
                }
                return@waitUntil false
            }
            var target: AccessibilityNodeInfo = node
            while (target.refresh() && !target.isClickable && target.isEnabled) target = target.parent ?: break
            if (!target.isEnabled) return@waitUntil false
            var ancestor: AccessibilityNodeInfo? = target
            while (ancestor != null && ancestor.className?.toString() != "android.webkit.WebView") ancestor = ancestor.parent
            if (ancestor == null && target.isClickable && target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return@waitUntil true
            val rect = Rect().apply { node.getBoundsInScreen(this) }
            if (rect.isEmpty) return@waitUntil false
            ParcelFileDescriptor.AutoCloseInputStream(automation.executeShellCommand("input touchscreen tap ${rect.centerX()} ${rect.centerY()}")).use { it.readBytes() }
            true
        }
    }

    fun longClick(value: String) = waitUntil {
        val found = visit { it.isVisibleToUser && it.text?.toString()?.contains(value) == true && !Rect().apply { it.getBoundsInScreen(this) }.isEmpty }
        if (found == null) {
            reader()?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)
            return@waitUntil false
        }
        val bounds = Rect().apply { found.getBoundsInScreen(this) }
        ParcelFileDescriptor.AutoCloseInputStream(automation.executeShellCommand("input touchscreen swipe ${bounds.centerX()} ${bounds.centerY()} ${bounds.centerX()} ${bounds.centerY()} 650")).use { it.readBytes() }
        true
    }

    fun openTask(title: String) {
        fun surface(): String? = when {
            exists("任务设置") -> null
            existsTag("task-list") -> "tasks"
            existsTag("workbench-list") -> "workbench"
            else -> null
        }
        fun layout(): String {
            val visible = mutableListOf<String>()
            visit { node ->
                if (node.isVisibleToUser) visible.add("${node.text}|${node.contentDescription}|${Rect().apply { node.getBoundsInScreen(this) }}")
                false
            }
            return visible.joinToString("\n")
        }
        fun awaitStableSurface() = waitUntil {
            val destination = surface() ?: return@waitUntil false
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            instrumentation.waitForIdleSync()
            val before = layout()
            val frames = CountDownLatch(2)
            instrumentation.runOnMainSync {
                Choreographer.getInstance().postFrameCallback(object : Choreographer.FrameCallback {
                    override fun doFrame(time: Long) {
                        frames.countDown()
                        if (frames.count > 0) Choreographer.getInstance().postFrameCallback(this)
                    }
                })
            }
            if (!frames.await(3, TimeUnit.SECONDS)) fail("Task navigation did not render two frames")
            destination == surface() && before == layout()
        }
        if (exists("任务设置")) {
            click("返回")
            awaitStableSurface()
        }
        if (!exists(title) && existsTag("workbench-list")) {
            clickTag("home-all-tasks")
            waitUntil { existsTag("task-list") && !existsTag("workbench-list") }
        }
        awaitStableSurface()
        click(title)
        waitUntil { exists(title) && exists("任务设置") && visit { it.isVisibleToUser && it.isEnabled && it.className?.toString() == "android.widget.EditText" } != null }
    }

    fun openFiles() {
        waitUntil { existsTag("workbench-list") || existsTag("task-information") || existsTag("conversation-settings") }
        if (existsTag("conversation-settings")) returnToConversation()
        if (existsTag("workbench-list")) click("新任务")
        waitUntil { existsTag("task-information") }
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).filterIsInstance<MainActivity>().single()
            activity.handleAction(MobileAction.LocalFileRecords, null)
        }
    }

    fun openTaskSettings() {
        if (!existsTag("conversation-settings")) click("任务设置")
        waitUntil { existsTag("conversation-settings") }
    }

    fun returnToConversation() {
        waitUntil {
            if (existsTag("conversation-settings")) {
                click("返回对话")
                false
            } else exists("任务设置")
        }
    }

    private fun awaitReaderMessage(scenario: ActivityScenario<MainActivity>, message: String, button: String? = null) {
        fun reader(view: View): WebView? {
            if (view is WebView) return view.takeIf { it.isShown }
            if (view is ViewGroup) for (i in 0 until view.childCount) reader(view.getChildAt(i))?.let { return it }
            return null
        }
        val script = """(() => {
            const bodies = [...document.querySelectorAll('.reader-message .message-body')]
                .filter(body => body.innerText.trim() === ${JSONObject.quote(message)});
            if (!bodies.length) {
                const viewport = document.querySelector('.reader-viewport');
                if (viewport) viewport.scrollBy(0, -viewport.clientHeight);
                return false;
            }
            if (bodies.length !== 1) return false;
            const selector = ${button?.let { JSONObject.quote(it) } ?: "null"};
            const target = selector ? bodies[0].closest('.reader-message').querySelector(selector) : bodies[0];
            if (!target || target.disabled || !target.getClientRects().length) return false;
            target.scrollIntoView({block: 'nearest'});
            if (selector) target.click();
            return true;
        })()"""
        waitUntil {
            val found = CompletableFuture<String>()
            scenario.onActivity { activity ->
                val web = reader(activity.window.decorView)
                if (web == null) found.complete("false") else web.evaluateJavascript(script) { found.complete(it) }
            }
            found.get(4, TimeUnit.SECONDS) == "true"
        }
    }

    fun openReplyMenu(scenario: ActivityScenario<MainActivity>, message: String) =
        awaitReaderMessage(scenario, message, "button[aria-label='更多消息操作']")

    fun selectBranch(scenario: ActivityScenario<MainActivity>, message: String, step: BranchStep, expectedMessage: String, expectedDraft: String) {
        awaitReaderMessage(scenario, message, ".message-branches button[aria-label='${step.label}']")
        awaitReaderMessage(scenario, expectedMessage)
        waitUntil { composerText() == expectedDraft }
    }

    fun enqueueInput() {
        openTaskSettings(); click("将当前输入加入队列")
        returnToConversation()
    }

    fun stopRunningReply() {
        openTaskSettings(); click("正在运行")
        waitUntil { exists("选择要停止的运行") }
        click("正在运行")
        waitUntil { exists("停止此次运行？") }
        click("停止运行")
        waitUntil { existsTag("conversation-settings") && !exists("停止此次运行？") }
        returnToConversation()
    }

    fun openApprovals() {
        openTaskSettings(); click("审批记录")
    }

    fun openUnassignedNewTask() {
        openWorkbench()
        clickTag("space-filter")
        click("未分配空间")
        clickTag("new-task")
        waitUntil { existsTag("task-information") }
    }

    fun openExecution() { if (!existsTag("conversation-settings")) click("任务设置"); click("执行方式") }

    fun awaitConnected() {
        if (existsTag("conversation-settings") || existsTag("task-information")) {
            val settingsOpen = existsTag("conversation-settings")
            openExecution()
            waitUntil { byId("permission-workspace_write-policy")?.isEnabled == true }
            clickTag("close-permission-picker")
            if (!settingsOpen) returnToConversation()
        } else waitUntil { connected() }
    }

    fun openWorkbench() {
        if (existsTag("conversation-settings")) returnToConversation()
        waitUntil {
            if (existsTag("workbench-list")) true
            else if (exists("返回")) {
                click("返回")
                automation.waitForIdle(200, 5000)
                false
            } else false
        }
    }

    fun awaitMessage(value: String) = waitUntil {
        if (contains(value)) true
        else {
            reader()?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
            false
        }
    }

    fun scrollHistoryToStart() {
        waitUntil { reader() != null }
        repeat(20) {
            val list = reader() ?: return@repeat
            if (!list.performAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD)) return
            SystemClock.sleep(180)
        }
        error("History did not reach its beginning")
    }

    private fun reader() = visit { node ->
        if (!node.isVisibleToUser || !node.isScrollable) false
        else {
            var current: AccessibilityNodeInfo? = node
            while (current != null && current.className?.toString() != "android.webkit.WebView") current = current.parent
            current != null
        }
    }

    private fun visible(node: AccessibilityNodeInfo) = node.isVisibleToUser && !Rect().apply { node.getBoundsInScreen(this) }.isEmpty

    private fun find(value: String, prefix: Boolean = false, substring: Boolean = false): AccessibilityNodeInfo? = visit { node ->
        visible(node) && listOf(node.text?.toString(), node.contentDescription?.toString()).filterNotNull().any {
            if (substring) it.contains(value) else if (prefix) it.startsWith(value) else it == value || it.startsWith("$value\n")
        }
    }
    private fun byId(id: String) = visit { it.viewIdResourceName == id || it.viewIdResourceName?.endsWith(":id/$id") == true }
    private fun scrollable() = visit { it.isVisibleToUser && it.isScrollable && it.className?.toString() == "android.widget.ListView" }
        ?: visit { it.isVisibleToUser && it.isScrollable && it.viewIdResourceName != "android:id/buttonPanel" }
    private fun visit(predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        val pending = ArrayDeque<AccessibilityNodeInfo>()
        automation.rootInActiveWindow?.let(pending::addLast)
        var count = 0
        while (pending.isNotEmpty() && count++ < 10000) {
            val node = pending.removeFirst()
            if (!node.refresh()) continue
            if (predicate(node)) return node
            repeat(node.childCount) { node.getChild(it)?.let(pending::addLast) }
        }
        return null
    }
}
