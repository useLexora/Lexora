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
import app.uselexora.mobile.ui.ConversationPage
import app.uselexora.mobile.ui.composerSource
import app.uselexora.mobile.ui.projectComposerRuns
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

    private fun snapshot(name: String, paintedOnScreen: (android.graphics.Bitmap) -> Boolean = { true }) {
        if (InstrumentationRegistry.getArguments().getString("captureScreenshots") != "true") return
        until("!document.getAnimations().some(a => a.playState === 'running' && Number.isFinite(a.effect?.getTiming().iterations))")
        val painted = CountDownLatch(1)
        compose.runOnUiThread {
            val web = host.getChildAt(0) as WebView
            web.postVisualStateCallback(0, object : WebView.VisualStateCallback() {
                override fun onComplete(requestId: Long) { web.postOnAnimation { web.postOnAnimation { painted.countDown() } } }
            })
        }
        assertTrue(painted.await(5, TimeUnit.SECONDS))
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val deadline = android.os.SystemClock.uptimeMillis() + 5_000
        do {
            val bitmap = requireNotNull(instrumentation.uiAutomation.takeScreenshot())
            try {
                if (paintedOnScreen(bitmap)) {
                    File(instrumentation.targetContext.filesDir, "$name.png").outputStream().use { assertTrue(bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)) }
                    return
                }
            } finally { bitmap.recycle() }
            Thread.sleep(100)
        } while (android.os.SystemClock.uptimeMillis() < deadline)
        fail("The system screenshot never contained both the group and composer phase: $name")
    }

    private fun tap(selector: String) {
        val point = JSONArray(js("""(() => { const el = document.querySelector('$selector'); el.scrollIntoView({block:'nearest',behavior:'instant'});
            const r=el.getBoundingClientRect(), x=r.left+r.width/2, y=r.top+r.height/2;
            if (!el.closest('button')?.contains(document.elementFromPoint(x,y))) return [];
            return [x/innerWidth,y/innerHeight] })()"""))
        assertEquals("Hit target: $selector", 2, point.length())
        val coords = IntArray(2)
        compose.runOnUiThread {
            val web = host.getChildAt(0) as WebView
            web.getLocationOnScreen(coords)
            coords[0] += (web.width * point.getDouble(0)).toInt(); coords[1] += (web.height * point.getDouble(1)).toInt()
        }
        val time = android.os.SystemClock.uptimeMillis()
        for (action in listOf(android.view.MotionEvent.ACTION_DOWN, android.view.MotionEvent.ACTION_UP)) {
            val event = android.view.MotionEvent.obtain(time, android.os.SystemClock.uptimeMillis(), action, coords[0].toFloat(), coords[1].toFloat(), 0)
            try { event.source = android.view.InputDevice.SOURCE_TOUCHSCREEN; InstrumentationRegistry.getInstrumentation().sendPointerSync(event) }
            finally { event.recycle() }
        }
    }


    private fun assertFullWidthReader() {
        val viewport = js("innerWidth").toDouble()
        compose.runOnUiThread {
            val web = host.getChildAt(0) as WebView
            assertEquals("WebView must fill the activity window", web.rootView.width, web.width)
            assertEquals(web.width / web.resources.displayMetrics.density.toDouble(), viewport, 1.0)
        }
    }

    private fun assertGroupTitle(issueCount: Int, mustOverflow: Boolean, group: String = "", short: Boolean = false) {
        val metrics = JSONObject(js("""(() => {
            const h=document.querySelector('$group .buddy-chat-activity-group__header'), bar=h.parentElement, label=h.querySelector('.buddy-chat-activity-row__label'),
                issue=Array.from(bar.children).find(el=>el.textContent.trim()==='$issueCount 项异常'), entry=h.closest('.reader-entry'), e=entry.getBoundingClientRect(), p=getComputedStyle(entry),
                b=bar.getBoundingClientRect(), r=issue.getBoundingClientRect(), style=getComputedStyle(label),
                lines=el=>{const range=document.createRange();range.selectNodeContents(el);return [...range.getClientRects()]},
                text=lines(issue), summary=lines(label), full=h.getAttribute('aria-label'), arrow=h.querySelector('.buddy-chat-activity-group__toggle').getBoundingClientRect(),
                lr=label.getBoundingClientRect(), hr=h.getBoundingClientRect();
            return {left:hr.left-e.left-parseFloat(p.paddingLeft),right:e.right-parseFloat(p.paddingRight)-r.right,
                gapToArrow:arrow.left-(label.scrollWidth>label.clientWidth?lr.right:summary.at(-1).right), centerOffset:(arrow.top+arrow.bottom-hr.top-hr.bottom)/2,
                issueGap:r.left-hr.right, rowFits:b.right<=e.right+1&&hr.right<=r.left+1, arrowWidth:arrow.width,
                issueFits:text.every(t=>t.left>=r.left-1&&t.right<=r.right+1),issueLines:new Set(text.map(t=>t.top)).size,
                lines:new Set(summary.map(t=>t.top)).size,ellipsis:style.textOverflow==='ellipsis'&&style.whiteSpace==='nowrap'&&style.overflowX==='hidden',
                overflow:label.scrollWidth-label.clientWidth,width:label.clientWidth,full,title:h.innerText,viewport:innerWidth,
                arrow:getComputedStyle(h.querySelector('.buddy-chat-activity-row__chevron')).visibility};
        })()"""))
        android.util.Log.i("ReaderLayout", metrics.toString())
        assertTrue(metrics.toString(), metrics.getBoolean("rowFits") && metrics.getDouble("left") >= -5.0 && metrics.getDouble("right") >= -1.0)
        assertTrue(metrics.toString(), metrics.getDouble("gapToArrow") in -1.0..12.0 && metrics.getDouble("arrowWidth") in 8.0..32.0)
        assertEquals(metrics.toString(), 0.0, metrics.getDouble("centerOffset"), 2.0)
        assertTrue(metrics.toString(), metrics.getDouble("issueGap") in -1.0..16.0)
        if (short) assertTrue("Short group must leave space unused: $metrics", metrics.getDouble("right") >= 24 && metrics.getInt("overflow") == 0)
        assertTrue(metrics.toString(), metrics.getBoolean("issueFits") && metrics.getBoolean("ellipsis"))
        assertEquals(metrics.toString(), 1, metrics.getInt("issueLines")); assertEquals(metrics.toString(), 1, metrics.getInt("lines"))
        assertTrue(metrics.toString(), metrics.getInt("width") > 0)
        if (mustOverflow && metrics.getInt("viewport") <= 420) assertTrue(metrics.toString(), metrics.getInt("overflow") > 0)
        assertEquals(metrics.toString(), "visible", metrics.getString("arrow"))
        assertFalse(metrics.toString(), Regex("运行中|正在执行|正在回复|bash").containsMatchIn(metrics.getString("full") + metrics.getString("title")))
        if (issueCount == 4) assertTrue(metrics.toString(), listOf("创建 25 次", "编辑 35 次", "读取 40 次", "运行 100 条命令").all(metrics.getString("full")::contains))
    }

    private fun assertOrderedSteps(command: String) {
        val m = JSONObject(js("""(() => {
            const group=document.querySelector('[data-activity-id=build-tools]'), steps=Array.from(group.querySelectorAll('[data-step-id]')),
                box=el=>el.getBoundingClientRect(), css=el=>getComputedStyle(el), titles=steps.map(s=>s.querySelector('.activity-step-heading')),
                icons=steps.map(s=>s.querySelector('.activity-step-icon')), path=el=>el.querySelector('path')?.getAttribute('d')||css(el).getPropertyValue('mask-image'),
                more=Array.from(group.querySelectorAll('button')).find(b=>b.textContent.trim()==='加载更多'), target=steps[2].querySelector('.activity-step-target'),
                content=group.querySelector('.buddy-chat-activity-group__content'), entry=box(group.closest('.reader-entry')),
                ancestors=[]; for(let el=steps[0]; el&&el!==group; el=el.parentElement) ancestors.push(el);
            const r=box(target), range=document.createRange();range.selectNodeContents(target);
            return {ids:steps.map(s=>s.dataset.stepId).join(','),thought:titles[0].innerText,tool:titles[1].innerText,shell:titles[2].innerText,
                command:target.textContent.trim(),toolTarget:steps[1].querySelector('.activity-step-target').textContent.trim(),
                safe:titles.every(t=>box(t).left>=entry.left&&box(t).right<=entry.right+1),
                clip:range.getBoundingClientRect().width>r.width && css(target).textOverflow==='ellipsis',
                inert:!steps[0].querySelector('button,a,[role=button]'),iconsVisible:icons.every(i=>box(i).width>=8&&box(i).height>=8&&css(i).visibility==='visible'),
                iconCount:new Set(icons.map(path)).size,
                line:ancestors.some(el=>parseFloat(css(el).borderLeftWidth)>0 || ['::before','::after'].some(p=>{const s=getComputedStyle(el,p);return !['none','normal'].includes(s.content)&&s.position==='absolute'&&parseFloat(s.width)<=3&&parseFloat(s.height)>20})),
                pageWidth:box(more).width, contentWidth:box(content).width, pageFont:parseFloat(css(more).fontSize), titleFont:parseFloat(css(titles[1]).fontSize),
                pageInk:css(more).color, titleInk:css(titles[1]).color,viewport:innerWidth};
        })()"""))
        android.util.Log.i("ReaderLayout", "steps=$m")
        assertEquals("thought,partners,step-73", m.getString("ids"))
        assertEquals("思考", m.getString("thought").trim()); assertTrue(m.toString(), m.getString("tool").contains("工具调用"))
        assertEquals("Partners and NPCs", m.getString("toolTarget"))
        assertTrue(m.toString(), m.getString("shell").contains("运行命令")); assertEquals(command, m.getString("command"))
        assertTrue(m.toString(), m.getBoolean("safe") && m.getBoolean("inert"))
        if (m.getInt("viewport") <= 420) assertTrue(m.toString(), m.getBoolean("clip"))
        assertTrue(m.toString(), m.getBoolean("iconsVisible")); assertEquals(m.toString(), 3, m.getInt("iconCount"))
        assertFalse("Step list has a left rail: $m", m.getBoolean("line"))
        assertTrue("Pagination should be secondary: $m", m.getDouble("pageWidth") < m.getDouble("contentWidth") / 2 &&
            (m.getDouble("pageFont") < m.getDouble("titleFont") || m.getString("pageInk") != m.getString("titleInk")))
    }

    private fun captureGroupAndPhase(name: String, group: String = "[data-activity-id=build-tools]") {
        if (InstrumentationRegistry.getArguments().getString("captureScreenshots") != "true") return
        val header = "$group .buddy-chat-activity-group__header"
        js("document.querySelector('$header').scrollIntoView({block:'nearest',behavior:'instant'})")
        val screen = IntArray(2)
        compose.runOnUiThread { host.rootView.getLocationOnScreen(screen) }
        val root = screen.copyOf()
        val phase = compose.onNodeWithTag("composerPhase").fetchSemanticsNode().boundsInWindow
        val gapY = phase.bottom.toInt() + root[1] + 3
        snapshot(name) { bitmap ->
            val issue = JSONArray(js("""(() => {const el=document.querySelector('$header').parentElement.lastElementChild, r=el.getBoundingClientRect();
                if(r.top<0 || r.bottom>innerHeight) { el.scrollIntoView({block:'nearest',behavior:'instant'});return [] }
                return [r.left/innerWidth,r.top/innerHeight,r.right/innerWidth,r.bottom/innerHeight,...getComputedStyle(el).color.match(/[0-9]+/g).map(Number)]})()"""))
            if (issue.length() == 0) return@snapshot false
            val region = android.graphics.Rect()
            compose.runOnUiThread {
                val web = host.getChildAt(0) as WebView
                web.getLocationOnScreen(screen)
                region.set(screen[0] + (issue.getDouble(0) * web.width).toInt(), screen[1] + (issue.getDouble(1) * web.height).toInt(),
                    screen[0] + (issue.getDouble(2) * web.width).toInt(), screen[1] + (issue.getDouble(3) * web.height).toInt())
            }
            val color = android.graphics.Color.rgb(issue.getInt(4), issue.getInt(5), issue.getInt(6))
            var paintedIssue = 0
            for (v in region.top until region.bottom step 2) for (u in region.left until region.right step 2) {
                if (bitmap.getPixel(u, v) == color) paintedIssue++
            }
            var paintedPhase = false
            for (v in phase.top.toInt() + root[1] until phase.bottom.toInt() + root[1] step 2) {
                for (u in phase.left.toInt() + root[0] until phase.right.toInt() + root[0] step 2) {
                    if (bitmap.getPixel(u, v) != bitmap.getPixel(u, gapY)) { paintedPhase = true; break }
                }
                if (paintedPhase) break
            }
            paintedIssue >= 4 && paintedPhase
        }
    }

    private fun assertSeparatePhase(label: String) {
        compose.onNodeWithText(label).assertIsDisplayed()
        val phase = compose.onNodeWithTag("composerPhase").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val frame = compose.onNodeWithTag("composerSurface").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        val density = host.resources.displayMetrics.density
        val gap = (frame.top - phase.bottom) / density
        assertEquals("phase=$phase composer=$frame", 8.0, gap.toDouble(), 0.6)
        android.util.Log.i("ReaderLayout", "phase=$phase composer=$frame gapDp=$gap")
    }


    @Test fun artifactHeadingKeepsItsLabelCountAndIconsOnOneLineWhenToggled() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val resource = JSONObject("""{"resourceId":"artifact:report","kind":"artifact","name":"验收报告.txt","mimeType":"text/plain","sizeBytes":"18","revision":"1","availability":"ready"}""")
        val page = JSONObject().put("items", JSONArray().put(resource)).put("nextCursor", JSONObject.NULL)
        assertTrue(schemas.response("runs.listOutputs", page))
        SyntheticProductService(schemas, listOf("runs.listOutputs")) { it.reply(page) }.use { service ->
            val client = service.connect()
            try {
                messages = listOf(message("answer", "已生成验收报告。"))
                runs = listOf(JSONObject().put("status", "completed"))
                artifactContext = ReaderArtifactContext(client.identity!!.partition, "branch", client, schemas) { _, _ -> error("No content download expected") }
                scale = 1.3f
                show()
                until("document.querySelector('.artifact-heading')?.getAttribute('aria-expanded') === 'true' && document.querySelector('.artifact-name')?.textContent === '验收报告.txt'")
                assertFullWidthReader()
                for ((index, expanded) in listOf(true, false, true).withIndex()) {
                    val label = if (index == 2) "Files created" else "产物"
                    if (index == 2) { language = "en"; update(); until("document.querySelector('.artifact-heading span')?.textContent === '$label'") }
                    until("document.querySelector('.artifact-heading').getAttribute('aria-expanded') === '$expanded' && (document.querySelector('.artifact-strip').getBoundingClientRect().height > 0) === $expanded")
                    val geometry = JSONObject(js("""(() => {
                        const [icon,title,count,arrow]=document.querySelector('.artifact-heading').children, text=document.createRange(); text.selectNodeContents(title);
                        const rects=Array.from(text.getClientRects()), c=count.getBoundingClientRect(), i=icon.getBoundingClientRect(), a=arrow.getBoundingClientRect(), t=rects[0];
                        return {title:title.textContent,count:count.textContent,lines:rects.length,centerDelta:Math.max(...[c,i,a].map(r=>Math.abs((r.top+r.bottom-t.top-t.bottom)/2))), icon:i.width,arrow:a.width, ordered:i.right<=t.left && t.right<=c.left && c.right<=a.left};
                    })()"""))
                    snapshot(listOf("01-artifacts-open", "02-artifacts-closed", "08-artifacts-open-en")[index])
                    assertEquals(geometry.toString(), label, geometry.getString("title")); assertEquals("1", geometry.getString("count"))
                    assertEquals(geometry.toString(), 1, geometry.getInt("lines")); assertTrue(geometry.toString(), geometry.getDouble("centerDelta") <= 2.0 && geometry.getBoolean("ordered"))
                    assertTrue(geometry.toString(), geometry.getDouble("icon") in 8.0..32.0 && geometry.getDouble("arrow") in 8.0..32.0)
                    if (index < 2) tap(".artifact-heading")
                }
                tap(".artifact-open"); compose.waitUntil(5_000) { actions.contains("resource:artifact:report") }
                assertEquals("true", js("document.querySelector('.artifact-heading').getAttribute('aria-expanded') === 'true'"))
            } finally { client.close() }
        }
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
        val answer = message("answer", "正在检查剩余步骤。")
        val at = "2026-11-11T05:00:01.000Z"
        val group = JSONObject().put("id", "build-tools").put("runId", "stream-run").put("afterMessageId", "explanation").put("createdAt", at)
            .put("toolCount", 200).put("runningCount", 1).put("failedCount", 4).put("interruptedCount", 0).put("activeToolName", "bash")
            .put("reasoningCount", 1).put("runningReasoningCount", 0).put("interruptedReasoningCount", 0)
            .put("counts", JSONArray(listOf("create" to 25, "edit" to 35, "read" to 40, "command" to 100).map { (category, count) -> JSONObject().put("category", category).put("count", count) }))
        messages = listOf(question.put("createdAt", "2026-11-11T05:00:00.000Z"), explanation.put("createdAt", at), answer.put("createdAt", "2026-11-11T05:00:02.000Z"))
        runs = listOf(completeRun(JSONObject()))
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val calls = java.util.concurrent.CopyOnWriteArrayList<String>()
        val shortGroup = JSONObject(group.toString()).put("id", "quick-check").put("afterMessageId", "user").put("toolCount", 2)
            .put("runningCount", 0).put("failedCount", 1).put("reasoningCount", 0).put("activeToolName", JSONObject.NULL)
            .put("counts", JSONArray().put(JSONObject().put("category", "read").put("count", 2)))
        val output = "仅此步骤的构建输出\n报告校验完成：4 项异常均已记录。"
        val command = "git log --oneline --stat --all"
        fun step(id: String, tool: String, message: String? = null, status: String = "completed") = JSONObject()
            .put("id", id).put("toolName", tool).put("status", status).put("messageId", message ?: JSONObject.NULL)
        val liveCommand = "pnpm lint:fix"
        val methods = listOf("conversations.listOrderedActivitySteps", "resources.get", "conversations.readActivityStepDetail", "conversations.listActivitySteps")
        SyntheticProductService(schemas, methods) { call ->
            when (call.method) {
                methods[0] -> {
                    val id = call.params.getString("groupId")
                    val cursor = call.params.opt("cursor") as? String
                    calls.add("steps:$id:${cursor ?: "first"}")
                    val items = when {
                        id == "quick-check" && cursor == null -> listOf(step("quick-a", "read", "quick-result", "failed"), step("quick-b", "read", "quick-ok"))
                        id == "build-tools" && cursor == null -> listOf(step("thought", "reasoning").put("kind", "reasoning"),
                            step("partners", "lexora_agents", "result-partners", "failed").put("summary", "Partners and NPCs"),
                            step("step-73", "bash", "result-73", "failed").put("summary", command))
                        id == "build-tools" && cursor == "next-page" -> listOf(step("step-75", "read", "result-75", "failed"),
                            step("step-76", "edit", "result-76", "failed"), step("step-200", "bash", status = "running").put("summary", liveCommand))
                        else -> error("Unexpected group/cursor: $id/$cursor")
                    }
                    call.reply(JSONObject().put("items", JSONArray(items)).put("nextCursor", if (id == "build-tools" && cursor == null) "next-page" else JSONObject.NULL))
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
                val page = ConversationPage(messages, listOf(shortGroup, group), runs)
                val state = MobileUiState().apply {
                    screen = MobileScreen.Conversation; connected = true; conversationReady = true; sendEnabled = true
                    selectedTask = JSONObject().put("id", "conversation").put("activeBranchId", "branch").put("title", "构建检查")
                    readerTopic = this@SharedReaderInstrumentedTest.topic; messages = page.messages; runs = page.runs; activityGroups = page.groups
                    composerSources = projectComposerRuns(page, "conversation", "branch")
                }
                dark = true; scale = 1.3f
                turn = ReaderTurnContext(ConversationTarget("conversation", "branch"), client, true, page.groups,
                    composer = state.composerSource, onComposerActivity = { state.composerActivity = it })
                compose.setContent {
                    val local = androidx.compose.ui.platform.LocalContext.current
                    val input = androidx.compose.runtime.remember { EditText(local).apply { showSoftInputOnFocus = false } }
                    LexoraTheme(darkTheme = true) { MobileShell(state, input, { _, _ -> }) { modifier ->
                        AndroidView(factory = { ReaderView(it).also { view -> host = view } }, modifier = modifier, onRelease = { it.dispose() })
                    } }
                }
                update()
                until("document.querySelector('main.dark [data-activity-id=build-tools][data-status=running] button[aria-expanded=false]') && document.body.innerText.includes('4 项异常') && document.body.innerText.includes('正在检查剩余步骤。')")
                compose.waitUntil(5_000) { state.composerActivity?.label == "正在执行" }
                assertFullWidthReader()
                assertEquals("true", js("(() => {const b=document.body.innerText; return b.indexOf('失败发生在打包阶段') >= 0 && b.indexOf('失败发生在打包阶段') < b.indexOf('4 项异常') && b.indexOf('4 项异常') < b.indexOf('正在检查剩余步骤。') && !b.includes('正在执行')})()"))
                assertTrue(calls.isEmpty()); assertTrue(transcriptRequests.isEmpty())
                val short = "[data-activity-id=quick-check]"; val long = "[data-activity-id=build-tools]"
                val toggle = ".buddy-chat-activity-group__toggle"
                assertSeparatePhase("正在执行"); assertGroupTitle(4, mustOverflow = true, group = long)
                assertGroupTitle(1, mustOverflow = false, group = short, short = true)
                captureGroupAndPhase("03-compact-group-closed")
                tap("$short $toggle"); until("document.querySelector('[data-step-id=quick-a]') !== null")
                assertGroupTitle(1, mustOverflow = false, group = short, short = true)
                assertEquals("Short steps should leave their natural trailing space", "true", js("""(() => {
                    const buttons=[...document.querySelectorAll('$short [data-step-id] button')], width=document.querySelector('$short .activity-steps').clientWidth;
                    return buttons.length===2 && buttons.every(b=>b.getBoundingClientRect().width < width-16) })()"""))
                captureGroupAndPhase("09-short-group-open", short)
                tap("$short $toggle"); until("!document.querySelector('[data-step-id=quick-a]')")
                tap("$long $toggle"); until("document.querySelector('[data-step-id=step-73]') !== null")
                assertGroupTitle(4, mustOverflow = true, group = long)
                assertOrderedSteps(command)
                captureGroupAndPhase("04-compact-group-open")
                tap("$long $toggle"); until("!document.querySelector('[data-step-id=step-73]')")
                assertGroupTitle(4, mustOverflow = true, group = long)
                tap("$long $toggle"); until("document.querySelector('[data-step-id=step-73]') !== null")
                assertEquals(listOf("steps:quick-check:first", "steps:build-tools:first"), calls.toList())
                tap("[data-step-id=step-73] button")
                until("document.querySelector('[data-step-id=step-73] pre')?.textContent === ${JSONObject.quote(output)}")
                assertEquals(listOf("resource:message:result-73", "body:message:result-73"), calls.takeLast(2))
                tap("[data-step-id=step-73] button")
                tap("$long .activity-load-more")
                until("document.querySelector('[data-step-id=step-200]') !== null")
                assertEquals(1, calls.count { it == "steps:build-tools:next-page" })
                assertEquals(JSONObject.quote("thought,partners,step-73,step-75,step-76,step-200"), js("Array.from(document.querySelectorAll('$long [data-step-id]'),s=>s.dataset.stepId).join(',')"))
                assertFalse(js("document.querySelector('$long').innerText").contains("加载更多"))
                assertEquals("4", js("Array.from(document.querySelectorAll('$long [data-step-id]')).filter(s=>s.innerText.includes('失败')).length"))
                js("document.querySelector('[data-step-id=step-200]').scrollIntoView({block:'center',behavior:'instant'})")
                until("(() => {const b=document.querySelector('[data-step-id=step-200] button'),r=b.getBoundingClientRect();return b.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))})()")
                snapshot("10-ordered-steps-next-page")
                tap("[data-step-id=step-200] button")
                until("document.body.innerText.includes('$liveCommand')")
                until("document.querySelector('[data-step-id=step-200]').innerText.includes('Build succeeded')")
                assertEquals(listOf("live:stream-run:build-tools:step-200", "live:stream-run:build-tools:step-200"), calls.filter { it.startsWith("live:") })
                assertTrue(transcriptRequests.isEmpty())
            } finally { client.close(); file.delete() }
        }
    }

    @Test fun legacyActivityCapabilityPagesToolOnlyRowsWithoutInventingReasoningOrCommands() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val old = "conversations.listActivitySteps"
        val cursors = java.util.concurrent.CopyOnWriteArrayList<String>()
        val group = JSONObject("""{"id":"legacy-tools","runId":"stream-run","afterMessageId":"user","createdAt":"2026-11-11T05:00:01.000Z","toolCount":2,"runningCount":0,"failedCount":0,"interruptedCount":0,"activeToolName":null,"reasoningCount":1,"runningReasoningCount":0,"interruptedReasoningCount":0,"counts":[{"category":"other","count":2}]}""")
        SyntheticProductService(schemas, listOf(old)) { call ->
            assertEquals(old, call.method)
            val cursor = call.params.opt("cursor") as? String; cursors.add(cursor ?: "first")
            val tool = if (cursor == null) "lookup" else "bash"
            val step = JSONObject().put("id", tool).put("toolName", tool).put("status", "completed").put("messageId", "result-$tool")
            call.reply(JSONObject().put("items", JSONArray().put(step)).put("nextCursor", if (cursor == null) "old-next" else JSONObject.NULL))
        }.use { service ->
            val client = service.connect()
            try {
                messages = listOf(message("user", "旧版服务验收", "user")); runs = listOf(completeRun(JSONObject().put("status", "completed")))
                turn = ReaderTurnContext(ConversationTarget("conversation", "branch"), client, true, listOf(group))
                show(); until("document.querySelector('[data-activity-id=legacy-tools] button[aria-expanded=false]') !== null")
                tap("[data-activity-id=legacy-tools] .buddy-chat-activity-group__toggle")
                until("document.querySelector('[data-step-id=lookup] .activity-step-target')?.textContent === 'lookup'")
                tap("[data-activity-id=legacy-tools] .activity-load-more")
                until("document.querySelector('[data-step-id=bash] .activity-step-target')?.textContent === 'bash'")
                assertEquals(listOf("first", "old-next"), cursors.toList())
                assertEquals(JSONObject.quote("lookup,bash"), js("Array.from(document.querySelectorAll('[data-step-id]'), s=>s.dataset.stepId).join(',')"))
            } finally { client.close() }
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
        scale = 1.3f
        show()
        until("document.querySelector('.buddy-chat-activity-group__header') !== null")
        assertFullWidthReader(); assertGroupTitle(1, mustOverflow = false)
        assertEquals("1", js("document.querySelectorAll('.message-author').length"))
        assertEquals("true", js("document.body.innerText.includes('2 条命令') && document.body.innerText.includes('1 项异常') && document.body.innerText.includes('257,111') && document.body.innerText.includes('45,832')"))
        snapshot("05-transcript-group-closed")
        tap(".buddy-chat-activity-group__toggle")
        until("document.querySelectorAll('.buddy-chat-tool__header').length === 4")
        snapshot("06-transcript-group-open")
        assertGroupTitle(1, mustOverflow = false)
        tap(".buddy-chat-activity-group__toggle")
        until("document.querySelector('.buddy-chat-activity-group__header').getAttribute('aria-expanded') === 'false' && !document.querySelector('[data-tool-detail-id=failed]')")
        tap(".buddy-chat-activity-group__issues")
        until("document.querySelector('[data-tool-detail-id=failed]')?.textContent.includes('No such file') === true")
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
            selectedTask = JSONObject().put("id", "conversation").put("activeBranchId", "branch").put("title", "输入与流式验收")
            readerTopic = this@SharedReaderInstrumentedTest.topic
            runs = listOf(completeRun(JSONObject()))
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
        fun liveMessage(text: String) = message("stream", text).put("textRange", JSONObject().put("revision", "1").put("start", 0).put("end", text.length).put("total", text.length))
        messages = listOf(liveMessage("# 输入与流式验收\n\n正文"))
        runs = state.runs
        fun projectPhase() { compose.runOnUiThread {
            state.runs = runs
            state.composerSources = projectComposerRuns(ConversationPage(messages = messages, runs = runs), "conversation", "branch")
            turn = ReaderTurnContext(enabled = true, composer = state.composerSource, onComposerActivity = { state.composerActivity = it })
        }; update() }
        projectPhase()
        until("document.querySelector('.message-author .message-avatar') !== null && document.body.innerText.includes('输入与流式验收')")
        compose.waitUntil(5_000) { state.composerActivity?.label == "正在回复" }
        val phase = compose.onNodeWithTag("composerPhase").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        compose.onNodeWithText("正在回复").assertIsDisplayed()
        val input = compose.onNodeWithTag("input").assertIsDisplayed().fetchSemanticsNode().boundsInRoot
        assertTrue("phase=$phase, input=$input", phase.height > 0 && phase.bottom <= input.top + 1)
        snapshot("07-streaming-composer")
        assertEquals("Avatar-side status: ${js("document.querySelector('.message-author').innerText")}", "true", js("!document.querySelector('.message-author [role=status], .message-author .stream-status, .run-hint')"))
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
            messages = listOf(liveMessage("# 输入与流式验收\n\n" + "正在输出中文表格、代码和公式。".repeat(index + 1)))
            update(); Thread.sleep(40)
            assertSame(original, composer)
        }
        compose.runOnUiThread {
            connection.commitText("中文输入保持连续😀", 1)
            connection.finishComposingText()
            assertEquals("中文输入保持连续😀", composer.text.toString())
            assertTrue(composer.hasFocus())
        }
        runs = listOf(completeRun(JSONObject().put("status", "completed"))); projectPhase()
        until("document.body.innerText.includes('正在输出中文表格')")
        compose.onNodeWithTag("composerPhase").assertDoesNotExist()
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
