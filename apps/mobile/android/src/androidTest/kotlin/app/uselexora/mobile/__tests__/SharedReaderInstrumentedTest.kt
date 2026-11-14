package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import android.content.ClipboardManager
import android.content.Context
import android.webkit.WebView
import android.widget.EditText
import android.view.inputmethod.EditorInfo
import app.uselexora.mobile.ui.MobileShell
import app.uselexora.mobile.ui.MobileUiState
import app.uselexora.mobile.ui.MobileScreen
import app.uselexora.mobile.ui.LexoraTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.ui.ReaderView
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.After
import org.junit.Rule
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class SharedReaderInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var host: ReaderView
    private var messages = emptyList<JSONObject>()
    private var topic = "test-topic"
    private var runs = emptyList<JSONObject>()
    private var details = emptyMap<String, app.uselexora.mobile.protocol.MobileMessageDetail>()
    private val actions = java.util.concurrent.CopyOnWriteArrayList<String>()
    private var transcripts = emptyMap<String, JSONObject>()
    private var language = "zh"
    private var dark = false
    private var scale = 1f
    private var readTarget: String? = null
    private val readResults = java.util.concurrent.CopyOnWriteArrayList<String>()

    @After fun disposeReader() {
        if (::host.isInitialized) compose.runOnUiThread { host.dispose() }
    }

    private fun message(id: String, text: String, role: String = "assistant") = JSONObject()
        .put("author", JSONObject().put("id", "default").put("name", "Lexora")).put("id", id).put("runId", "stream-run").put("role", role)
        .put("body", JSONObject().put("kind", "text").put("text", text))

    private fun show() {
        compose.setContent { AndroidView(factory = { ReaderView(it).also { view -> host = view } }, modifier = Modifier.fillMaxSize(), onRelease = { it.dispose() }) }
        update()
    }
    private fun completeRun(value: JSONObject): JSONObject = JSONObject("""{"id":"stream-run","buddyId":"default","approvalPolicy":"manual","branchId":"branch","completedAt":null,"conversationId":"conversation","errorCode":null,"executionProfile":"read_only","generation":"1","lastEventSequence":"0","modelId":"model","providerId":"provider","purpose":"chat","reasoningLevel":null,"startedAt":"2026-11-11T05:00:00Z","status":"running","triggeringMessageId":"user"}""").also { run ->
        for (key in value.keys()) run.put(key, value.get(key))
    }
    private fun update() {
        compose.runOnUiThread { host.update(messages, topic, details, runs.map(::completeRun), dark, scale,
            { actions.add("message:${it.getString("id")}") }, { actions.add("resource:${it.getString("resourceId")}") }, { actions.add("detail:${it.getString("id")}") }, { message, action -> actions.add("$action:${message.getString("id")}") }, language = language, transcripts = transcripts, resultRunId = readTarget, onReadResult = { readResults.add(it) }) }
    }
    private fun js(script: String): String {
        val result = AtomicReference<String>()
        val latch = CountDownLatch(1)
        compose.runOnUiThread { (host.getChildAt(0) as WebView).evaluateJavascript(script) { result.set(it); latch.countDown() } }
        check(latch.await(5, TimeUnit.SECONDS)) { "WebView did not answer" }
        return result.get()
    }
    private fun until(script: String) {
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) {
            if (js(script) == "true") return
            Thread.sleep(100)
        }
        fail("Reader condition failed: $script; page=${js("document.body.innerText")}")
    }

    @Test fun languageUpdatesMessageAndMarkdownActionsWithoutTranslatingUserText() {
        val original = app.uselexora.mobile.ui.MobileAppearance.language
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        messages = listOf(message("localized", "保留用户原文\n\n```text\n关闭 全部空间\n```"))
        show()
        until("document.querySelector('.message-actions [aria-label=复制消息]') !== null")
        until("document.querySelector('.markstream-vue [aria-label=复制]') !== null")
        try {
            compose.runOnUiThread { app.uselexora.mobile.ui.MobileAppearance.selectLanguage(context, "en") }
            language = "en"
            update()
            until("document.querySelector('.message-actions [aria-label=\"Copy message\"]') !== null")
            until("document.querySelector('.markstream-vue [aria-label=Copy]') !== null")
            assertEquals(JSONObject.quote("en"), js("document.documentElement.lang"))
            assertEquals("true", js("document.body.innerText.includes('保留用户原文') && document.body.innerText.includes('关闭 全部空间')"))
            assertEquals("false", js("Array.from(document.querySelectorAll('[aria-label]')).some(x => /[\\u4e00-\\u9fff]/.test(x.getAttribute('aria-label')))"))
            compose.runOnUiThread { app.uselexora.mobile.ui.MobileAppearance.selectLanguage(context, "zh") }
            language = "zh"
            update()
            until("document.querySelector('.markstream-vue [aria-label=复制]') !== null")
        } finally { compose.runOnUiThread { app.uselexora.mobile.ui.MobileAppearance.selectLanguage(context, original) } }
    }

    @Test fun tablesMathCodeAndNativeActionsWorkInPackagedWebView() {
        val code = "  val text = \"中文😀\"\n\n    println(text)\n"
        val text = "# 共享正文验收\n\n| 项目 | 结果 |\n| --- | --- |\n| 中文表格需要自动换行显示完整内容 | 完成 |\n\n```kotlin\n${code}```\n\n行内公式 ${'$'}E=mc^2${'$'}\n\n${'$'}${'$'}\n\\frac{1}{2}+\\sqrt{x}\n${'$'}${'$'}\n\n![远程图片](https://example.invalid/no-request.png)\n\n<script>window.readerInjected=true</script>"
        messages = listOf(message("rich", text).put("createdAt", "2026-11-11T05:00:00Z").put("resources", JSONArray().put(JSONObject()
            .put("resourceId", "attachment-1").put("name", "example.txt").put("mimeType", "text/plain").put("sizeBytes", "30").put("availability", "ready"))))
        show()
        until("document.querySelector('table') !== null && document.querySelectorAll('.katex').length >= 2")
        until("document.querySelector('.message-avatar img')?.naturalWidth > 0")
        assertEquals("true", js("document.querySelector('.message-time').textContent.trim().length > 0"))
        assertEquals("1", js("document.querySelectorAll('.message-actions').length"))
        assertEquals("false", js("window.readerInjected === true"))
        assertEquals("0", js("document.querySelectorAll('.markstream-vue img').length"))
        assertEquals("false", js("performance.getEntriesByType('resource').some(x => x.name.includes('example.invalid'))"))
        assertEquals("true", js("document.body.innerText.includes('<script>window.readerInjected=true</script>')"))
        assertEquals("true", js("document.documentElement.scrollWidth <= innerWidth"))
        js("Array.from(document.querySelectorAll('button')).find(x => /copy|复制/i.test((x.getAttribute('aria-label')||'')+' '+x.textContent) && x.closest('.markstream-vue')).click()")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        compose.runOnUiThread {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            assertEquals(code, clipboard.primaryClip?.getItemAt(0)?.text?.toString())
        }
        js("document.querySelector('.resource-link').click(); document.querySelector('.reader-message').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true}))")
        compose.waitUntil(5_000) { actions.size == 2 }
        assertEquals(listOf("resource:attachment-1", "message:rich"), actions)
        File(context.filesDir, "shared-reader-rich.png").outputStream().use { InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun messageFootersConfirmCopyAndKeepBranchingAndMoreActionsReachable() {
        val user = message("user", "输入", "user").put("createdAt", "2026-11-11T05:00:00Z")
            .put("body", JSONObject().put("kind", "user").put("content", JSONObject().put("kind", "editable").put("content", MobileContentAdapter.textContent("输入"))))
        messages = listOf(user, message("reply", "回复").put("createdAt", "2026-11-11T05:01:00Z"))
        runs = listOf(JSONObject().put("id", "stream-run").put("status", "running"))
        show()
        until("document.querySelector('.user .message-actions') !== null")
        assertEquals("false", js("document.querySelector('.assistant .message-actions') !== null"))
        js("document.querySelector('.user [aria-label=更多消息操作]').click()")
        compose.waitUntil(5_000) { actions.contains("message:user") }
        runs = listOf(JSONObject().put("id", "stream-run").put("status", "completed"))
        update()
        until("document.querySelector('[aria-label=从这里继续]') !== null")
        js("document.querySelector('[aria-label=从这里继续]').click()")
        compose.waitUntil(5_000) { actions.contains("followup:reply") }
        js("document.querySelector('.assistant [aria-label=复制消息]').click()")
        until("document.querySelector('.assistant [aria-label=已复制]') !== null")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        compose.runOnUiThread { assertEquals("回复", (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip?.getItemAt(0)?.text?.toString()) }
        js("document.querySelector('.assistant [aria-label=更多消息操作]').click()")
        compose.waitUntil(5_000) { actions.contains("message:reply") }
        until("document.querySelector('.assistant [aria-label=复制消息]') !== null")
    }

    @Test fun aTurnSharesIdentityAndShowsEveryToolWithExpandableInputAndOutput() {
        fun tool(id: String, name: String, summary: String) = message(id, "", "tool")
            .put("tool", JSONObject().put("name", name).put("isError", false))
            .put("body", JSONObject().put("kind", "resource").put("resourceId", "message:$id").put("previewText", summary))
        messages = listOf(message("narration", "先检查当前环境，再整理结果。"), tool("shell", "bash", "检查系统和工作目录"), tool("read", "read", "README.md"), message("answer", "已完成环境检查。"))
        runs = listOf(JSONObject().put("id", "stream-run").put("status", "completed"))
        show()
        until("document.querySelectorAll('.tool-call-header').length === 2")
        assertEquals("1", js("document.querySelectorAll('.message-author').length"))
        assertEquals("1", js("document.querySelectorAll('.message-actions').length"))
        assertEquals("true", js("document.querySelector('[data-message-id=narration]').classList.contains('intermediate') && document.querySelector('[data-message-id=answer] .message-actions') !== null"))
        assertEquals("true", js("document.body.innerText.includes('检查系统和工作目录') && document.body.innerText.includes('README.md')"))
        js("document.querySelector('[data-message-id=shell] .tool-call-header').click()")
        compose.waitUntil(5_000) { actions.contains("detail:shell") }
        details = mapOf("shell" to app.uselexora.mobile.protocol.MobileMessageDetail(text = "命令：uname -s\n输出：Linux", sourceBody = messages[1].getJSONObject("body").toString()))
        update()
        until("document.querySelector('.tool-output')?.textContent.includes('Linux') === true")
        assertEquals("1", js("document.querySelectorAll('.message-author').length"))
        assertEquals("true", js("document.documentElement.scrollWidth <= innerWidth"))
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.filesDir, "reader-turn-tools.png").outputStream().use { InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun pendingTurnUsesItsActorAvatarBeforeAnyAssistantMessage() {
        messages = listOf(message("user", "检查环境", "user"))
        runs = listOf(JSONObject("""{"id":"stream-run","buddyId":"default","branchId":"branch","triggeringMessageId":"user","generation":"1","status":"running","startedAt":"2026-11-11T05:00:00Z","completedAt":null}"""))
        val events = JSONArray().put(JSONObject("""{"runId":"stream-run","sequence":1,"createdAt":"2026-11-11T05:00:00Z","type":"tool.started","payload":{"toolCallId":"shell","toolName":"bash","presentation":{"card":"terminal","command":"uname -s","cwd":".","exitCode":null,"signal":null,"description":null,"output":null,"truncated":false}}}"""))
        transcripts = mapOf("stream-run" to JSONObject().put("events", events).put("loaded", true))
        show()
        until("document.querySelector('.reader-turn .message-avatar img')?.naturalWidth > 0")
        val pendingAvatar = js("document.querySelector('.reader-turn .message-avatar img').src")
        assertTrue(pendingAvatar.contains("actor-lexora"))
        messages = messages + message("answer", "已完成环境检查。")
        runs = listOf(JSONObject(runs[0].toString()).put("status", "completed").put("completedAt", "2026-11-11T05:01:00Z"))
        update()
        until("document.body.innerText.includes('已完成环境检查。')")
        assertEquals(pendingAvatar, js("document.querySelector('.reader-turn .message-avatar img').src"))
        assertEquals("1", js("document.querySelectorAll('.message-author').length"))
    }

    @Test fun desktopActivityGroupsRenderReasoningToolsIssuesAndCompaction() {
        val events = JSONArray()
        fun event(type: String, payload: String) { events.put(JSONObject().put("runId", "stream-run").put("sequence", events.length() + 1).put("createdAt", "2026-11-11T05:00:00Z").put("type", type).put("payload", JSONObject(payload))) }
        event("message.block.completed", """{"messageId":"reason","contentIndex":0,"kind":"reasoning","content":"Checking environment and file layout"}""")
        event("tool.completed", """{"toolCallId":"shell","toolName":"bash","isError":false,"presentation":{"card":"terminal","command":"uname -s","cwd":".","exitCode":0,"signal":null,"description":"检查运行环境","output":"Linux","truncated":false}}""")
        event("tool.completed", """{"toolCallId":"failed","toolName":"bash","isError":true,"presentation":{"card":"terminal","command":"cat missing.txt","cwd":".","exitCode":1,"signal":null,"description":"检查文件","output":"No such file","truncated":false}}""")
        event("tool.completed", """{"toolCallId":"read","toolName":"read","isError":false,"presentation":{"card":"read","path":"src/example.ts","language":"typescript","lineStart":1,"description":null,"output":"export const value = 1","truncated":false}}""")
        event("tool.completed", """{"toolCallId":"edit","toolName":"edit","isError":false,"presentation":{"card":"diff","path":"src/example.ts","operation":"edited","firstChangedLine":1,"description":null,"output":null,"truncated":false,"diff":"@@ -1 +1 @@\n-export const value = 1\n+export const value = 2"}}""")
        event("context.compaction.completed", """{"tokensBefore":257111,"estimatedTokensAfter":45832}""")
        event("message.completed", """{"messageId":"answer","phase":"final_answer","content":{"text":"已完成环境检查。"},"stopReason":"stop"}""")
        messages = listOf(message("answer", "已完成环境检查。"))
        runs = listOf(JSONObject("""{"id":"stream-run","branchId":"branch","triggeringMessageId":"user","generation":"1","status":"completed","startedAt":"2026-11-11T05:00:00Z","completedAt":"2026-11-11T05:01:00Z"}"""))
        transcripts = mapOf("stream-run" to JSONObject().put("events", events).put("loaded", true))
        show()
        until("document.querySelector('.buddy-chat-activity-group__header') !== null")
        assertEquals("1", js("document.querySelectorAll('.message-author').length"))
        assertEquals("true", js("document.body.innerText.includes('2 条命令') && document.body.innerText.includes('1 项异常') && document.body.innerText.includes('257,111') && document.body.innerText.includes('45,832')"))
        js("document.querySelector('.buddy-chat-activity-group__header').click()")
        until("document.querySelectorAll('.buddy-chat-tool__header').length === 4")
        assertEquals("true", js("document.body.innerText.includes('uname -s') && document.body.innerText.includes('cat missing.txt')"))
        js("document.querySelector('.buddy-chat-reasoning-entry__header').click()")
        until("document.body.innerText.includes('Checking environment and file layout')")
        js("document.querySelector('[data-tool-call-id=shell] button').click()")
        until("document.querySelector('[data-tool-detail-id=shell]')?.textContent.includes('Linux') === true")
        js("document.querySelector('[data-tool-call-id=read] button').click(); document.querySelector('[data-tool-call-id=edit] button').click()")
        until("document.querySelector('.buddy-chat-tool-read')?.textContent.includes('export const value = 1') === true && document.querySelector('.buddy-chat-tool-diff .is-added') !== null")
        Thread.sleep(400)
        assertEquals("true", js("document.documentElement.scrollWidth <= innerWidth"))
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.filesDir, "reader-desktop-tools.png").outputStream().use { InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        dark = true; update()
        until("document.querySelector('main.dark .buddy-chat-activity-group.is-open') !== null")
        event("tool.started", """{"toolCallId":"streaming","toolName":"bash","presentation":{"card":"terminal","command":"sleep 1","cwd":".","exitCode":null,"signal":null,"description":null,"output":null,"truncated":false}}""")
        runs = listOf(JSONObject(runs[0].toString()).put("status", "running").put("completedAt", JSONObject.NULL))
        transcripts = mapOf("stream-run" to JSONObject().put("events", events).put("loaded", true))
        update()
        until("document.querySelector('.buddy-chat-run-activity') !== null && document.querySelector('[data-tool-call-id=streaming].is-running') !== null")
        assertEquals("true", js("document.querySelector('[data-tool-detail-id=shell]') !== null && document.querySelector('.buddy-chat-activity-group.is-open') !== null"))
        event("tool.completed", """{"toolCallId":"streaming","toolName":"bash","isError":false,"presentation":{"card":"terminal","command":"sleep 1","cwd":".","exitCode":0,"signal":null,"description":null,"output":"done","truncated":false}}""")
        runs = listOf(JSONObject(runs[0].toString()).put("status", "completed").put("completedAt", "2026-11-11T05:01:00Z"))
        transcripts = mapOf("stream-run" to JSONObject().put("events", events).put("loaded", true))
        update()
        until("document.querySelector('.buddy-chat-run-activity') === null && document.querySelector('[data-tool-call-id=streaming].is-completed') !== null")
        val replacement = JSONArray().put(events.getJSONObject(1))
        transcripts = mapOf("stream-run" to JSONObject().put("events", replacement).put("loaded", true))
        update()
        until("document.querySelector('[data-tool-call-id=shell]') !== null && document.querySelector('[data-tool-call-id=streaming]') === null && document.querySelector('[data-tool-call-id=failed]') === null && !document.body.innerText.includes('257,111')")
    }

    @Test fun streamingPreservesReadingPositionAndResetsOnTopicChange() {
        messages = (1..120).map { message("history-$it", "## 历史 $it\n\n" + "历史阅读内容。".repeat(20)) } + message("stream", "# 持续输出\n\n正文")
        runs = listOf(JSONObject().put("id", "stream-run").put("status", "running"))
        show()
        until("document.body.innerText.includes('持续输出')")
        until("(()=>{const v=document.querySelector('.reader-viewport'); return v.scrollHeight-v.scrollTop-v.clientHeight<30})()")
        assertEquals("true", js("document.querySelectorAll('[data-entry-id]').length < 25 && document.querySelector('.reader-content').dataset.messageCount === '121'"))
        js("document.querySelector('.reader-viewport').scrollTop=80")
        until("document.querySelector('.latest-button') !== null")
        Thread.sleep(400)
        val before = js("document.querySelector('.reader-viewport').scrollTop").toDouble()
        repeat(30) { index ->
            messages = messages.dropLast(1) + message("stream", "# 持续输出\n\n" + "流式片段$index，中文😀。".repeat(index + 1))
            update(); Thread.sleep(40)
        }
        Thread.sleep(800)
        assertEquals(before, js("document.querySelector('.reader-viewport').scrollTop").toDouble(), 2.0)
        js("document.querySelector('.latest-button').click()")
        until("(()=>{const v=document.querySelector('.reader-viewport'); return v.scrollHeight-v.scrollTop-v.clientHeight<30})()")
        runs = emptyList(); update()
        until("document.body.innerText.includes('流式片段29')")
        dark = true; scale = 1.3f; update()
        until("document.querySelector('main.dark') !== null && parseFloat(getComputedStyle(document.querySelector('main')).fontSize) >= 19.4")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.filesDir, "shared-reader-dark.png").outputStream().use { InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        topic = "other-topic"; messages = listOf(message("other", "另一分支独立内容")); update()
        until("document.body.innerText.includes('另一分支独立内容') && !document.body.innerText.includes('历史 1')")
    }
    @Test fun onlyTheVisibleCompletedResultReportsRead() {
        messages = (1..80).map { message("history-$it", "历史阅读。".repeat(40)).put("runId", "history-run") } + message("result", "最新结果需要实际可见")
        runs = listOf(JSONObject().put("id", "stream-run").put("status", "completed"))
        show()
        until("document.body.innerText.includes('最新结果需要实际可见')")
        js("document.querySelector('.reader-viewport').scrollTop=0")
        until("document.querySelector('.latest-button') !== null && document.querySelector('.reader-viewport').scrollTop === 0")
        readTarget = "stream-run"; update()
        Thread.sleep(500)
        assertTrue(readResults.isEmpty())
        js("document.querySelector('.latest-button').click()")
        compose.waitUntil(10_000) { readResults.size == 1 }
        assertEquals(listOf("stream-run"), readResults.toList())
        readTarget = "other-run"; update()
        Thread.sleep(300)
        assertEquals(1, readResults.size)
        runs = listOf(JSONObject().put("id", "stream-run").put("status", "running"))
        readTarget = "stream-run"; update()
        Thread.sleep(300)
        assertEquals(1, readResults.size)
    }

    @Test fun nativeComposerKeepsItsCompositionWhileSharedBodyStreams() {
        val state = MobileUiState().apply {
            screen = MobileScreen.Conversation
            selectedTask = JSONObject().put("id", "input-task").put("activeBranchId", "input-branch").put("title", "输入与流式验收")
            sendEnabled = true
        }
        lateinit var composer: EditText
        compose.setContent {
            LexoraTheme {
                val context = androidx.compose.ui.platform.LocalContext.current
                composer = androidx.compose.runtime.remember { EditText(context).apply {
                    inputType = android.text.InputType.TYPE_CLASS_TEXT or android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE
                    imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI
                    showSoftInputOnFocus = false
                } }
                MobileShell(state, composer, { _, _ -> }) { modifier ->
                    AndroidView(factory = { ReaderView(it).also { view ->
            host = view
            (view.getChildAt(0) as WebView).webChromeClient = object : android.webkit.WebChromeClient() {
                override fun onConsoleMessage(message: android.webkit.ConsoleMessage): Boolean {
                    File(view.context.filesDir, "reader-console.txt").appendText("${message.messageLevel()}: ${message.message()} @${message.lineNumber()}\n")
                    return true
                }
            }
        } }, modifier = modifier, onRelease = { it.dispose() })
                }
            }
        }
        messages = listOf(message("stream", "# 输入与流式验收\n\n正文"))
        runs = listOf(JSONObject().put("id", "stream-run").put("status", "running"))
        update()
        until("document.body.innerText.includes('输入与流式验收')")
        val original = composer
        lateinit var connection: android.view.inputmethod.InputConnection
        compose.runOnUiThread {
            composer.requestFocus()
            connection = composer.onCreateInputConnection(EditorInfo())!!
        }
        repeat(25) { index ->
            compose.runOnUiThread { connection.setComposingText("拼音组合-$index", 1) }
            messages = listOf(message("stream", "# 输入与流式验收\n\n" + "正在输出中文表格、代码和公式。".repeat(index + 1)))
            update(); Thread.sleep(40)
            assertSame(original, composer)
        }
        compose.runOnUiThread {
            connection.commitText("中文输入保持连续😀", 1)
            connection.finishComposingText()
            assertEquals("中文输入保持连续😀", composer.text.toString())
            assertTrue(composer.hasFocus())
        }
        runs = emptyList(); update()
        until("document.body.innerText.includes('正在输出中文表格')")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        File(context.filesDir, "shared-reader-composer.png").outputStream().use { InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            val previous = AtomicReference<WebView>()
            compose.runOnUiThread { previous.set(host.getChildAt(0) as WebView); assertTrue(previous.get().webViewRenderProcess!!.terminate()) }
            compose.waitUntil(5_000) {
                var replaced = false
                compose.runOnUiThread { replaced = host.getChildAt(0) is WebView && host.getChildAt(0) !== previous.get() }
                replaced
            }
            until("document.body?.innerText.includes('正在输出中文表格') === true")
            compose.runOnUiThread { assertEquals("中文输入保持连续😀", composer.text.toString()) }
            assertTrue(actions.isEmpty())
        }
    }

    @Test fun incompleteMarkdownConvergesAfterTheFinalStreamFrame() {
        val text = "# 流式结构验收\n\n| 项目 | 结果 |\n| --- | --- |\n| 中文 | 正常 |\n\n```kotlin\nval answer = 42\nprintln(answer)\n```\n\n行内 ${'$'}E=mc^2${'$'}\n\n${'$'}${'$'}\n\\frac{1}{2}\n${'$'}${'$'}"
        messages = listOf(message("partial", "# 流式结构验收\n\n"))
        runs = listOf(JSONObject().put("id", "stream-run").put("status", "running"))
        show()
        until("document.body.innerText.includes('流式结构验收')")
        for (length in 16..text.length step 5) {
            messages = listOf(message("partial", text.take(length)))
            update(); Thread.sleep(40)
            assertEquals("true", js("document.querySelector('h1')?.textContent.includes('流式结构验收') === true"))
        }
        messages = listOf(message("partial", text)); runs = emptyList(); update()
        until("document.querySelectorAll('table').length === 1 && document.querySelectorAll('.katex').length >= 2 && document.body.innerText.includes('println(answer)')")
        assertEquals("1", js("document.querySelectorAll('[data-message-id=partial]').length"))
        assertEquals("true", js("document.querySelector('table').innerText.includes('正常')"))
    }

}
