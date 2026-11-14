package app.uselexora.mobile

import android.graphics.Rect
import android.os.SystemClock
import android.os.ParcelFileDescriptor
import android.view.Choreographer
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

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
            exists("工作台选项") -> "workbench"
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
        if (!exists(title) && exists("工作台选项")) {
            click("搜索任务")
            waitUntil { existsTag("task-list") && !exists("工作台选项") }
        }
        awaitStableSurface()
        click(title)
        waitUntil { exists(title) && exists("任务设置") && visit { it.isVisibleToUser && it.isEnabled && it.className?.toString() == "android.widget.EditText" } != null }
    }

    fun openFiles() {
        if (!exists("任务设置")) click("新任务")
        click("添加附件"); click("任务文件")
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

    fun selectBranch(id: String) {
        clickTag("branch-switcher"); clickTag("branch:$id")
        waitUntil { !existsTag("branch:$id") }
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

    fun openDrafts() {
        if (exists("任务设置")) { click("任务设置") }
        else click("工作台选项")
        click("本地草稿")
        waitUntil { exists("手机草稿") }
    }

    fun openExecution() { if (!existsTag("conversation-settings")) click("任务设置"); click("执行方式") }

    fun awaitConnected() = waitUntil {
        if (connected()) true
        else {
            if (existsTag("conversation-settings")) scrollable()?.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)
            false
        }
    }

    fun openWorkbench() {
        if (existsTag("conversation-settings")) returnToConversation()
        waitUntil {
            if (existsTag("workbench-list")) true
            else {
                click("返回")
                automation.waitForIdle(200, 5000)
                false
            }
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
    private fun scrollable() = visit { it.isVisibleToUser && it.isScrollable }
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
