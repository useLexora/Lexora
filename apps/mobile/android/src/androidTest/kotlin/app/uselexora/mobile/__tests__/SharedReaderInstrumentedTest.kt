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
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.ui.ReaderTurnContext
import app.uselexora.mobile.ui.ReaderView
import app.uselexora.mobile.protocol.ConversationTarget
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.ui.ReaderArtifactContext
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
    private var branches = emptyList<JSONObject>()
    private var selectedBranchId: String? = null
    private var language = "zh"
    private var dark = false
    private var scale = 1f
    private var readTarget: String? = null
    private var anchorMessageId: String? = null
    private var anchorRequestId: String? = null
    private var hasLaterMessages = false
    private var turn = ReaderTurnContext()
    private var artifactContext: ReaderArtifactContext? = null
    private val transcriptRequests = java.util.concurrent.CopyOnWriteArrayList<String>()
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
            { actions.add("message:${it.getString("id")}") }, { actions.add("resource:${it.getString("resourceId")}") }, { actions.add("detail:${it.getString("id")}") }, { message, action -> actions.add("$action:${message.getString("id")}") }, language = language, transcripts = transcripts, resultRunId = readTarget, onReadResult = { readResults.add(it) }, anchorMessageId = anchorMessageId, anchorRequestId = anchorRequestId, hasLaterMessages = hasLaterMessages, onLatest = { actions.add("latest:$topic") }, branches = branches, selectedBranchId = selectedBranchId, onBranch = { actions.add("branch:${it.getString("id")}") }, turn = turn, onOlder = { retry -> actions.add("older:$retry") }, artifactContext = artifactContext, onLoadTranscript = { id, _ -> transcriptRequests.add(id) }) }
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

    @Test fun sameModeSkinChangesUpdateReaderWithoutReplacingContentOrScroll() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val original = app.uselexora.mobile.ui.MobileAppearance.skinId
        try {
            compose.runOnUiThread { app.uselexora.mobile.ui.MobileAppearance.selectSkin(context, "paper") }
            messages = (1..30).map { message("skin-history-$it", "Reading position $it. ".repeat(30)) }
            show()
            until("document.querySelector('.reader-content')?.dataset.messageCount === '30'")
            until("(()=>{const v=document.querySelector('.reader-viewport');return v.scrollHeight > v.clientHeight})()")
            js("window.skinContent=document.querySelector('.reader-content');document.querySelector('.reader-viewport').scrollTop=80")
            until("document.querySelector('.latest-button') !== null")
            Thread.sleep(300)
            val before = js("document.querySelector('.reader-viewport').scrollTop").toDouble()
            for (id in listOf("color-play", "mecha-armor", "paper")) {
                compose.runOnUiThread { app.uselexora.mobile.ui.MobileAppearance.selectSkin(context, id) }
                update()
                val palette = app.uselexora.mobile.ui.BuiltinSkins.get(context, id).variant(false).palette
                val canvas = JSONObject.quote(palette.getJSONObject("variables").getString("--buddy-surface-canvas"))
                until("getComputedStyle(document.querySelector('main')).getPropertyValue('--buddy-surface-canvas').trim() === $canvas")
                assertEquals("true", js("window.skinContent === document.querySelector('.reader-content') && window.skinContent.dataset.messageCount === '30' && !document.querySelector('main.dark')"))
                assertEquals(before, js("document.querySelector('.reader-viewport').scrollTop").toDouble(), 2.0)
            }
        } finally {
            compose.runOnUiThread { app.uselexora.mobile.ui.MobileAppearance.selectSkin(context, original) }
        }
    }

    @Test fun acceptedFirstInputStaysVisibleWhileTheConversationSynchronizes() {
        val body = "只显示这条输入"
        val first = message("user-1", body, "user")
        val state = MobileUiState().apply {
            screen = MobileScreen.Conversation; connected = true; conversationReady = false
            viewBranchId = "branch"; readerTopic = topic; showingAcceptedInput = true
            messages = listOf(first); readingCached = true; historyHasMore = true
        }
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        lateinit var input: EditText
        compose.runOnUiThread { input = EditText(context) }
        compose.setContent {
            LexoraTheme {
                MobileShell(state, input, { _, _ -> }) { modifier ->
                    AndroidView(factory = { ReaderView(it).also { reader -> host = reader } }, modifier = modifier, onRelease = { it.dispose() },
                        update = { it.update(state.messages, state.readerTopic, emptyMap(), emptyList(), false, 1f, {}, {}, {}) })
                }
            }
        }
        until("document.querySelectorAll('[data-message-id=\"user-1\"]').length === 1 && document.body.innerText.includes('$body') && !document.querySelector('.reader-empty')")
        for (resource in listOf(R.string.mobile_sync_required, R.string.mobile_load_earlier, R.string.mobile_showing_phone_content_updating))
            compose.onNodeWithText(app.uselexora.mobile.i18n.mobileText(resource)).assertDoesNotExist()
        compose.runOnUiThread {
            state.readingCached = false; state.historyHasMore = false; state.conversationReady = true
            state.messages = listOf(message("user-1", body, "user"), message("reply-1", "收到"))
        }
        until("document.body.innerText.includes('收到') && document.querySelectorAll('[data-message-id=\"user-1\"]').length === 1")
    }

    @Test fun compactTurnKeepsNarrationAndFailedGroupWithoutLoadingItsStepsOrTranscript() {
        val question = message("user", "请修复构建", "user")
        val explanation = message("explanation", "失败发生在打包阶段")
        val answer = message("answer", "已切换构建方式并修复")
        val at = "2026-11-11T05:00:01.000Z"
        val group = JSONObject().put("id", "build-tools").put("runId", "stream-run").put("afterMessageId", "explanation").put("createdAt", at)
            .put("toolCount", 200).put("runningCount", 0).put("failedCount", 1).put("interruptedCount", 0).put("activeToolName", JSONObject.NULL)
            .put("reasoningCount", 1).put("runningReasoningCount", 0).put("interruptedReasoningCount", 0)
            .put("counts", JSONArray().put(JSONObject().put("category", "command").put("count", 200)))
        messages = listOf(question.put("createdAt", "2026-11-11T05:00:00.000Z"), explanation.put("createdAt", at), answer.put("createdAt", "2026-11-11T05:00:02.000Z"))
        runs = listOf(JSONObject().put("status", "completed"))
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val calls = java.util.concurrent.CopyOnWriteArrayList<String>()
        val output = "仅此步骤的构建输出"
        val liveCommand = "make synthetic-build"
        val methods = listOf("conversations.listActivitySteps", "resources.get", "conversations.readActivityStepDetail")
        SyntheticProductService(schemas, methods) { call ->
            when (call.method) {
                methods[0] -> {
                    calls.add("steps:${call.params.getString("groupId")}")
                    val step = JSONObject().put("id", "step-73").put("toolName", "bash").put("status", "failed").put("messageId", "result-73")
                    val pending = JSONObject().put("id", "step-200").put("toolName", "bash").put("status", "running").put("messageId", JSONObject.NULL)
                    call.reply(JSONObject().put("items", JSONArray().put(step).put(pending)).put("nextCursor", "next-page"))
                }
                methods[1] -> {
                    val id = call.params.getString("resourceId")
                    calls.add("resource:$id")
                    call.reply(JSONObject().put("resourceId", id).put("kind", "message").put("name", "工具输出").put("mimeType", "text/plain").put("sizeBytes", output.toByteArray().size.toString()).put("revision", "1").put("availability", "ready"))
                }
                methods[2] -> {
                    calls.add("live:${call.params.getString("runId")}:${call.params.getString("groupId")}:${call.params.getString("stepId")}")
                    val done = call.params.has("knownRevision")
                    call.reply(JSONObject().put("stepId", "step-200").put("messageId", JSONObject.NULL).put("status", if (done) "completed" else "running")
                        .put("available", true).put("truncated", false).put("revision", (if (done) "b" else "a").repeat(64)).put("text", if (done) "Build succeeded" else liveCommand))
                }
            }
        }.use { service ->
            val client = service.connect()
            val file = File.createTempFile("step-detail", ".txt", context.cacheDir)
            try {
                artifactContext = ReaderArtifactContext(client.identity!!.partition, "branch", client, schemas) { _, resource ->
                    calls.add("body:${resource.getString("resourceId")}"); file.apply { writeText(output) }
                }
                turn = ReaderTurnContext(ConversationTarget("conversation", "branch"), client, true, listOf(group))
                show()
                until("document.querySelector('[data-activity-id=build-tools] button[aria-expanded=false]') && document.body.innerText.includes('200') && document.body.innerText.includes('已切换构建方式并修复')")
                assertEquals("true", js("(() => {const b=document.body.innerText; return b.indexOf('失败发生在打包阶段') >= 0 && b.indexOf('失败发生在打包阶段') < b.indexOf('200') && b.indexOf('200') < b.indexOf('已切换构建方式并修复')})()"))
                assertTrue(calls.isEmpty()); assertTrue(transcriptRequests.isEmpty())
                js("document.querySelector('[data-activity-id=build-tools] button[aria-expanded]').click()")
                until("document.querySelector('[data-step-id=step-73]') !== null")
                assertEquals(listOf("steps:build-tools"), calls.toList())
                js("document.querySelector('[data-step-id=step-73] button').click()")
                until("document.body.innerText.includes('$output')")
                assertEquals(listOf("steps:build-tools", "resource:message:result-73", "body:message:result-73"), calls.toList())
                js("document.querySelector('[data-step-id=step-73] button').click(); document.querySelector('[data-step-id=step-200] button').click(); document.querySelector('[data-step-id=step-200]').scrollIntoView()")
                until("document.body.innerText.includes('$liveCommand')")
                until("document.querySelector('[data-step-id=step-200]').innerText.includes('Build succeeded')")
                assertEquals(listOf("live:stream-run:build-tools:step-200", "live:stream-run:build-tools:step-200"), calls.filter { it.startsWith("live:") })
                assertTrue(transcriptRequests.isEmpty())
            } finally { client.close(); file.delete() }
        }
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

    @Test fun streamingRichMarkdownConvergesAndKeepsNativeActionsSafe() {
        val code = "  val text = \"中文😀\"\n\n    println(text)\n"
        val text = "# 共享正文验收\n\n| 项目 | 结果 |\n| --- | --- |\n| 中文表格需要自动换行显示完整内容 | 完成 |\n\n```kotlin\n${code}```\n\n行内公式 ${'$'}E=mc^2${'$'}\n\n${'$'}${'$'}\n\\frac{1}{2}+\\sqrt{x}\n${'$'}${'$'}\n\n![远程图片](https://example.invalid/no-request.png)\n\n<script>window.readerInjected=true</script>"
        val finalMessage = message("rich", text).put("createdAt", "2026-11-11T05:00:00Z").put("resources", JSONArray().put(JSONObject()
            .put("resourceId", "attachment-1").put("name", "example.txt").put("mimeType", "text/plain").put("sizeBytes", "30").put("availability", "ready")))
        val heading = "共享正文验收"
        runs = listOf(JSONObject().put("status", "running"))
        messages = listOf(message("rich", "# $heading"))
        show()
        until("document.querySelector('h1')?.textContent === '$heading'")
        val codeLine = "println(text)"
        val incomplete = text.substring(0, text.indexOf(codeLine) + codeLine.length)
        messages = listOf(message("rich", incomplete))
        update()
        until("document.querySelector('h1')?.textContent === '$heading' && document.body.innerText.includes('$codeLine') && document.querySelectorAll('[data-message-id=rich]').length === 1")
        messages = listOf(finalMessage)
        runs = emptyList()
        update()
        until("document.querySelectorAll('table').length === 1 && document.querySelector('table').innerText.includes('完成') && document.querySelectorAll('.katex').length >= 2 && document.body.innerText.includes('println(text)')")
        assertEquals("1", js("document.querySelectorAll('[data-message-id=rich]').length"))
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
    }

    @Test fun messageFootersConfirmCopyAndKeepBranchingAndMoreActionsReachable() {
        val user = message("user", "输入", "user").put("createdAt", "2026-11-11T05:00:00Z")
            .put("body", JSONObject().put("kind", "user").put("content", JSONObject().put("kind", "editable").put("content", MobileContentAdapter.textContent("输入"))))
        messages = listOf(user, message("reply", "回复").put("createdAt", "2026-11-11T05:01:00Z"))
        runs = listOf(JSONObject().put("id", "stream-run").put("status", "running"))
        show()
        until("document.querySelector('.user .message-actions') !== null")
        assertEquals("false", js("document.querySelector('.assistant .message-actions') !== null"))
        assertEquals("true", js("document.querySelector('.user [aria-label=更多消息操作]') === null"))
        runs = listOf(JSONObject().put("id", "stream-run").put("status", "completed"))
        update()
        until("document.querySelector('.assistant .message-actions') !== null")
        assertEquals("true", js("document.querySelectorAll('.assistant .message-actions button').length===2 && !document.querySelector('[aria-label=从这里继续], [aria-label=重新生成]')"))
        js("document.querySelector('.user [aria-label=编辑消息]').click()")
        compose.waitUntil(5_000) { actions.contains("edit:user") }
        js("document.querySelector('.assistant [aria-label=复制消息]').click()")
        until("document.querySelector('.assistant [aria-label=已复制]') !== null")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        compose.runOnUiThread { assertEquals("回复", (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).primaryClip?.getItemAt(0)?.text?.toString()) }
        js("document.querySelector('.assistant [aria-label=更多消息操作]').click()")
        compose.waitUntil(5_000) { actions.contains("message:reply") }
        until("document.querySelector('.assistant [aria-label=复制消息]') !== null")
    }

    @Test fun publicNarrationLongPressKeepsSelectionWithoutOpeningReplyActions() {
        turn = ReaderTurnContext(enabled = true)
        messages = listOf(message("note", "独立公开说明"), message("reply", "最终答复").put("commentary",
            JSONObject().put("text", "混合公开说明").put("range", JSONObject().put("revision", "c:4").put("start", 0).put("end", 6).put("total", 6))))
        runs = listOf(JSONObject().put("status", "completed"))
        show()
        until("document.querySelector('[data-message-id=reply] .reader-narration') !== null")
        for ((selector, text) in listOf("[data-message-id=note] .message-body" to "独立公开说明",
            "[data-message-id=reply] .reader-narration" to "混合公开说明", "[data-message-id=reply] .message-body" to "最终答复")) {
            assertEquals("true", js("""(() => {
                const el = document.querySelector('$selector'), range = document.createRange();
                range.selectNodeContents(el); getSelection().removeAllRanges(); getSelection().addRange(range);
                return el.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true})) && getSelection().toString().includes('$text');
            })()"""))
        }
        assertFalse(actions.any { it.startsWith("message:") })
        js("document.querySelector('.assistant [aria-label=更多消息操作]').click()")
        compose.waitUntil(5_000) { actions.contains("message:reply") }
    }

    @Test fun compactFooterNavigatesExistingBranchesIndependentlyOfMore() {
        fun branch(id: String, parent: String?, fork: String?, time: String) = JSONObject()
            .put("id", id).put("conversationId", "conversation").put("parentBranchId", parent ?: JSONObject.NULL)
            .put("forkedFromMessageId", fork ?: JSONObject.NULL).put("createdAt", time)
        branches = listOf(branch("branch", null, null, "2026-11-11T05:00:00Z"), branch("retry", "branch", "user", "2026-11-11T05:01:00Z"))
        selectedBranchId = "retry"
        val user = message("user", "输入", "user").put("branchId", "branch")
        messages = listOf(user, message("reply", "回复").put("branchId", "retry"))
        runs = listOf(JSONObject().put("id", "stream-run").put("branchId", "retry").put("status", "completed"))
        show()
        until("document.querySelector('.message-branches')?.textContent.includes('2/2') === true")
        assertEquals("true", js("document.documentElement.scrollWidth<=innerWidth"))
        assertEquals("true", js("document.querySelector('[aria-label=下一个分支]').disabled && !document.querySelector('[aria-label=上一个分支]').disabled"))
        assertEquals("true", js("""(() => {
            const icon = document.querySelector('[aria-label=上一个分支] .desktop-icon');
            const bounds = icon.getBoundingClientRect(), style = getComputedStyle(icon);
            return bounds.width > 0 && bounds.height > 0 && style.backgroundColor === style.color
                && style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.webkitMaskImage.startsWith('url(');
        })()"""))
        js("document.querySelector('[aria-label=上一个分支]').click()")
        compose.waitUntil(5_000) { actions.contains("branch:branch") }
        selectedBranchId = "branch"
        messages = listOf(user, message("original", "原回复").put("branchId", "branch"))
        runs = listOf(JSONObject().put("id", "stream-run").put("status", "completed"))
        update()
        until("document.querySelector('.message-branches')?.textContent.includes('1/2') === true")
        assertEquals("true", js("""(() => {
            const footer = document.querySelector('.assistant .message-actions');
            const bounds = label => footer.querySelector('[aria-label="' + label + '"]').getBoundingClientRect();
            const next = bounds('下一个分支'), copy = bounds('复制消息'), more = bounds('更多消息操作');
            return [next, copy, more].every(rect => rect.width === 32 && rect.height >= 44)
                && copy.left - next.right === 4 && more.left - copy.right === 2;
        })()"""))
        js("document.querySelector('[aria-label=下一个分支]').click(); document.querySelector('.assistant [aria-label=更多消息操作]').click()")
        compose.waitUntil(5_000) { actions.containsAll(listOf("branch:retry", "message:original")) }
        dark = true; scale = 1.5f; update()
        until("document.querySelector('main.dark') !== null")
        assertEquals("true", js("document.documentElement.scrollWidth<=innerWidth && document.querySelector('.message-branches').getBoundingClientRect().width>0"))
    }

    @Test fun emptyReplyBranchesKeepNavigationAndTheirTerminalStatus() {
        fun branch(id: String, parent: String?, minute: Int) = JSONObject()
            .put("id", id).put("conversationId", "conversation").put("parentBranchId", parent ?: JSONObject.NULL)
            .put("forkedFromMessageId", if (parent == null) JSONObject.NULL else "user").put("createdAt", "2026-11-11T05:0$minute:00Z")
        branches = listOf(branch("branch", null, 0), branch("retry", "branch", 1), branch("stopped", "retry", 2), branch("last", "retry", 3))
        val user = message("user", "输入", "user").put("branchId", "branch")
        fun select(id: String, status: String = "completed", text: String = "回复 $id") {
            selectedBranchId = id
            topic = "branch-$id"
            messages = listOf(user, message("reply-$id", text).put("branchId", id).put("runId", "run-$id"))
            runs = listOf(JSONObject().put("id", "run-$id").put("branchId", id).put("status", status))
        }
        fun navigate(label: String, id: String) {
            actions.clear()
            js("document.querySelector('[aria-label=\"$label\"]').click()")
            compose.waitUntil(5_000) { actions.contains("branch:$id") }
        }
        select("retry")
        show()
        until("document.querySelector('.message-branches')?.textContent.includes('2/4') === true")
        navigate("下一个分支", "stopped")
        select("stopped", "cancelled", "")
        update()
        until("document.querySelector('.message-branches')?.textContent.includes('3/4') === true && document.querySelector('.reader-turn-status')?.textContent.includes('已停止') === true")
        assertEquals("true", js("document.querySelector('[aria-label=重新生成]') === null && document.querySelectorAll('.message-branches').length===1"))
        navigate("下一个分支", "last")
        select("last")
        update()
        until("document.querySelector('.message-branches')?.textContent.includes('4/4') === true && document.body.innerText.includes('回复 last')")
        navigate("上一个分支", "stopped")
        select("stopped", "cancelled", "")
        transcripts = mapOf("run-stopped" to JSONObject().put("events", JSONArray()).put("loaded", true))
        update()
        until("document.querySelector('.message-branches')?.textContent.includes('3/4') === true")
        language = "en"; dark = true; scale = 1.5f; update()
        until("document.querySelector('.reader-turn-status')?.textContent.includes('Stopped') === true")
        assertEquals("true", js("document.documentElement.scrollWidth<=innerWidth && document.querySelector('[aria-label=\"Previous branch\"]').getBoundingClientRect().height>0"))
        for ((status, label) in listOf("failed" to "Failed", "completed" to "No reply generated")) {
            select("stopped", status, "")
            update()
            until("document.querySelector('.reader-turn-status')?.textContent.includes('$label') === true && document.querySelector('.message-branches')?.textContent.includes('3/4') === true")
        }
        navigate("Previous branch", "retry")
        select("retry")
        update()
        until("document.querySelector('.message-branches')?.textContent.includes('2/4') === true && document.body.innerText.includes('回复 retry')")
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
        dark = true; update()
        until("document.querySelector('main.dark .buddy-chat-activity-group.is-open') !== null")
        event("tool.started", """{"toolCallId":"streaming","toolName":"bash","presentation":{"card":"terminal","command":"sleep 1","cwd":".","exitCode":null,"signal":null,"description":null,"output":null,"truncated":false}}""")
        runs = listOf(JSONObject(runs[0].toString()).put("status", "running").put("completedAt", JSONObject.NULL))
        transcripts = mapOf("stream-run" to JSONObject().put("events", events).put("loaded", true))
        update()
        until("document.querySelector('.buddy-chat-run-activity, .stream-status') === null && document.querySelector('[data-tool-call-id=streaming].is-running') !== null")
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

    @Test fun shortHistoryFillsAndRetryFloatsWithoutMovingTheMessage() {
        val selector = "document.querySelector('[data-message-id=tail]')"
        messages = listOf(message("tail", "当前消息"))
        turn = ReaderTurnContext(enabled = true, historyAvailable = true, historyPage = 1)
        show()
        until("$selector !== null")
        compose.waitUntil(5000) { actions.count { it == "older:false" } == 1 }
        js("window.tailTop=$selector.getBoundingClientRect().top")
        turn = ReaderTurnContext(enabled = true, historyAvailable = true, historyError = "offline", historyPage = 1)
        update()
        until("document.querySelector('.history-retry') !== null")
        assertEquals("true", js("(() => {const b=document.querySelector('.history-retry'); return getComputedStyle(b).position==='absolute' && !b.closest('.reader-viewport') && b.getBoundingClientRect().height>=44 && Math.abs(window.tailTop-$selector.getBoundingClientRect().top)<1})()"))
        js("document.querySelector('.history-retry').click()")
        compose.waitUntil(5000) { "older:true" in actions }
        turn = ReaderTurnContext(enabled = true, historyAvailable = true, historyPage = 2)
        update()
        compose.waitUntil(5000) { actions.count { it == "older:false" } == 2 }
        assertEquals("true", js("!document.querySelector('.history-retry') && Math.abs(window.tailTop-$selector.getBoundingClientRect().top)<1"))
        messages = (1..40).map { message("early-$it", "以往消息 $it") } + messages
        turn = ReaderTurnContext(enabled = true, historyAvailable = true, historyPage = 3)
        update()
        until("(()=>{const v=document.querySelector('.reader-viewport'); return v.scrollHeight>v.clientHeight && v.scrollTop>0})()")
        assertEquals(listOf("older:false", "older:true", "older:false"), actions.filter { it.startsWith("older:") })
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
        topic = "other-topic"; messages = listOf(message("other", "另一分支独立内容")); update()
        until("document.body.innerText.includes('另一分支独立内容') && !document.body.innerText.includes('历史 1')")
    }
    @Test fun anchorRequestsPreserveReadingThroughPrependAndStreamingUntilExplicitLatest() {
        messages = (21..80).map { message("history-$it", "历史 $it。".repeat(30)) }
        anchorMessageId = "history-40"; anchorRequestId = "search-1"; hasLaterMessages = true
        show()
        until("document.querySelector('main').dataset.anchorMessageId === 'history-40'")
        until("(()=>{const v=document.querySelector('.reader-viewport'); const m=document.querySelector('[data-message-id=history-40]'); return m && Math.abs(m.getBoundingClientRect().top-v.getBoundingClientRect().top)<3})()")
        js("document.querySelector('.reader-viewport').scrollTop += 140")
        Thread.sleep(300)
        js("window.readingOffset=document.querySelector('[data-message-id=history-40]').getBoundingClientRect().top")
        messages = (1..20).map { message("history-$it", "更早的历史 $it。".repeat(30)) } + messages
        update()
        until("document.querySelector('.reader-content').dataset.messageCount === '80'")
        until("Math.abs(document.querySelector('[data-message-id=history-40]').getBoundingClientRect().top-window.readingOffset)<3")
        repeat(5) { index ->
            messages = messages.dropLast(1) + message("history-80", "流式更新 $index。".repeat(40 + index))
            update(); Thread.sleep(80)
        }
        Thread.sleep(300)
        assertEquals("true", js("Math.abs(document.querySelector('[data-message-id=history-40]').getBoundingClientRect().top-window.readingOffset)<3"))
        anchorMessageId = "history-30"; anchorRequestId = "search-2"; update()
        until("document.querySelector('main').dataset.anchorMessageId === 'history-30'")
        js("document.querySelector('.latest-button').click()")
        compose.waitUntil(5000) { actions.count { it == "latest:$topic" } == 1 }
        turn = ReaderTurnContext(latestLoading = true)
        update()
        until("document.querySelector('.latest-button:disabled .latest-spinner') !== null && !document.querySelector('.history-progress')")
        turn = ReaderTurnContext(latestError = "offline")
        update()
        until("document.querySelector('.latest-failed')?.getAttribute('aria-label').includes('offline') === true")
        assertEquals("history-30", js("document.querySelector('main').dataset.anchorMessageId").trim('"'))
        js("document.querySelector('.latest-failed').click()")
        compose.waitUntil(5000) { actions.count { it == "latest:$topic" } == 2 }
        turn = ReaderTurnContext()
        anchorMessageId = null; anchorRequestId = null; hasLaterMessages = false
        messages = messages + message("latest", "真实最新消息")
        update()
        until("document.querySelector('[data-message-id=latest]') !== null && !document.querySelector('.latest-button') && (()=>{const v=document.querySelector('.reader-viewport');return v.scrollHeight-v.scrollTop-v.clientHeight<30})()")
    }

    @Test fun missingAndCrossTopicAnchorsNeverSilentlyResolveToAnotherMessage() {
        messages = (1..60).map { message("history-$it", "历史 $it。".repeat(30)) }
        anchorMessageId = "history-20"; anchorRequestId = "search-1"
        show()
        until("document.querySelector('main').dataset.anchorMessageId === 'history-20'")
        val before = js("document.querySelector('.reader-viewport').scrollTop").toDouble()
        anchorMessageId = "missing"; anchorRequestId = "search-2"; update()
        until("document.querySelector('main').dataset.anchorStatus === 'missing' && document.querySelector('[role=status]').textContent.includes('无法在当前对话中定位')")
        assertEquals(before, js("document.querySelector('.reader-viewport').scrollTop").toDouble(), 3.0)
        assertEquals("true", js("document.querySelector('.latest-button') !== null && !document.querySelector('main').dataset.anchorMessageId"))
        topic = "other-topic"
        messages = (1..30).map { message("other-$it", "其他任务 $it。".repeat(30)) }
        update()
        until("document.querySelector('[data-message-id=other-30]') !== null")
        assertEquals("idle", js("document.querySelector('main').dataset.anchorStatus").trim('"'))
        compose.runOnUiThread {
            val receive = ReaderView::class.java.getDeclaredMethod("receive", JSONObject::class.java).apply { isAccessible = true }
            receive.invoke(host, JSONObject().put("action", "latest").put("topic", "test-topic"))
            receive.invoke(host, JSONObject().put("action", "message").put("topic", topic).put("id", "history-20"))
        }
        assertTrue(actions.isEmpty())
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
            runs = listOf(JSONObject().put("id", "stream-run").put("status", "running").put("generation", "1"))
            connected = true
            conversationReady = true
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
                    AndroidView(factory = { ReaderView(it).also { view -> host = view } }, modifier = modifier, onRelease = { it.dispose() })
                }
            }
        }
        messages = listOf(message("stream", "# 输入与流式验收\n\n正文"))
        runs = listOf(JSONObject().put("id", "stream-run").put("status", "running"))
        update()
        until("document.querySelector('.message-author .stream-status') !== null && !document.querySelector('.run-hint')")
        compose.onNodeWithTag("streaming-status").assertDoesNotExist()
        compose.onNodeWithTag("send").assertIsDisplayed()
        compose.onNodeWithTag("stop-run").assertIsDisplayed()
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

}
