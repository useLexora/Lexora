package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.webkit.*
import android.widget.FrameLayout
import android.widget.Toast
import android.widget.TextView
import android.view.Gravity
import android.view.View
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.viewinterop.AndroidView
import app.uselexora.mobile.BuildConfig
import app.uselexora.mobile.protocol.MobileMessageDetail
import app.uselexora.mobile.protocol.MobileMessagePresentation
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream

@Composable
fun WebMessageTimeline(
    messages: List<JSONObject>,
    topic: String,
    modifier: Modifier = Modifier,
    details: Map<String, MobileMessageDetail> = emptyMap(),
    runs: List<JSONObject> = emptyList(),
    onMessageAction: (JSONObject) -> Unit,
    onResource: (JSONObject) -> Unit,
    onLoadDetail: (JSONObject) -> Unit,
    onQuickAction: (JSONObject, String) -> Unit = { _, _ -> },
    transcripts: Map<String, JSONObject> = emptyMap(),
    onLoadTranscript: (String, Boolean) -> Unit = { _, _ -> },
    resultRunId: String? = null,
    onReadResult: (String) -> Unit = {},
    avatarContext: ReaderAvatarContext? = null,
    anchorMessageId: String? = null,
    anchorRequestId: String? = null,
    hasLaterMessages: Boolean = false,
    onLatest: () -> Unit = {},
    artifactContext: ReaderArtifactContext? = null,
    onResourceActions: (JSONObject) -> Unit = onResource,
    branches: List<JSONObject> = emptyList(),
    selectedBranchId: String? = null,
    onBranch: (JSONObject) -> Unit = {},
    onMessageMenu: ((JSONObject, IntRect?, Boolean) -> Unit)? = null,
    turn: ReaderTurnContext = ReaderTurnContext(),
    onOlder: (Boolean) -> Unit = {},
) {
    val dark = MobileAppearance.isDark(isSystemInDarkTheme())
    val fontScale = LocalConfiguration.current.fontScale
    val language = MobileAppearance.language
    AndroidView(
        factory = { ReaderView(it) }, modifier = modifier.testTag("message-list"),
        onRelease = { it.dispose() },
        update = { it.update(messages, topic, details, runs, dark, fontScale, onMessageAction, onResource, onLoadDetail, onQuickAction, language, transcripts, onLoadTranscript, resultRunId, onReadResult, avatarContext, anchorMessageId, anchorRequestId, hasLaterMessages, onLatest, artifactContext, onResourceActions, branches, selectedBranchId, onBranch, onMessageMenu, turn, onOlder) },
    )
}

@SuppressLint("SetJavaScriptEnabled")
class ReaderView(context: Context) : FrameLayout(context) {
    private val handler = Handler(Looper.getMainLooper())
    private val projection = ReaderProjection()
    private val protocol = app.uselexora.mobile.protocol.ProtocolSchemas(JSONObject(context.assets.open("reader-protocol.json").bufferedReader().use { it.readText() }))
    private var browser: WebView? = null
    private var port: WebMessagePort? = null
    private var ready = false
    private var disposed = false
    private var topic = ""
    private var messages = emptyList<JSONObject>()
    private var details = emptyMap<String, MobileMessageDetail>()
    private var runs = emptyList<JSONObject>()
    private var transcripts = emptyMap<String, JSONObject>()
    private var loadTranscript: (String, Boolean) -> Unit = { _, _ -> }
    private var turn = ReaderTurnContext()
    private var turnRunIds = emptySet<String>()
    private var older: (Boolean) -> Unit = {}
    private val steps = ReaderActivitySteps { schedulePublish() }
    private val stepReads = ReaderStepDetailReads()
    private var dark = false
    private var fontScale = 1f
    private var messageAction: (JSONObject) -> Unit = {}
    private var messageMenu: ((JSONObject, IntRect?, Boolean) -> Unit)? = null
    private var branches = emptyList<JSONObject>()
    private var selectedBranchId: String? = null
    private var sentBranches: List<JSONObject>? = null
    private var sentSelectedBranchId: String? = null
    private var selectBranch: (JSONObject) -> Unit = {}
    private var resourceAction: (JSONObject) -> Unit = {}
    private var detailAction: (JSONObject) -> Unit = {}
    private var scheduled = false
    private val flush = Runnable { scheduled = false; publish() }
    private val status = TextView(context).apply {
        textSize = 16f; gravity = Gravity.CENTER
        setTextColor(android.graphics.Color.rgb(91, 116, 106))
        setPadding(24, 24, 24, 24)
        setOnClickListener { if (loadFailed) restartBrowser() }
    }
    private var loadFailed = false
    private val loadTimeout = Runnable { if (!ready && !disposed) showLoadFailure() }
    private fun showLoadFailure() {
        loadFailed = true; status.gravity = Gravity.CENTER; status.visibility = View.VISIBLE
        status.text = mobileText(R.string.mobile_conversation_display_unavailable_tap_to_retry)
    }
    private fun showInitialMessage() {
        val source = messages.singleOrNull()?.takeIf { it.optString("role") == "user" }
        val text = source?.let { MobileMessagePresentation.message(it).text }.orEmpty()
        status.visibility = if (text.isEmpty()) View.GONE else View.VISIBLE
        status.gravity = Gravity.TOP or Gravity.START; status.text = text
    }
    private var recoveryAttempts = 0
    private var resultRunId: String? = null
    private var readResult: (String) -> Unit = {}
    private var anchorMessageId: String? = null
    private var anchorRequestId: String? = null
    private var hasLaterMessages = false
    private var latest: () -> Unit = {}
    @Volatile private var avatars: ReaderAvatars? = null
    private var avatarAuthors = emptySet<String>()
    @Volatile private var artifacts: ReaderArtifacts? = null
    private var sentOutputs: JSONObject? = null
    private var toolImages: ReaderToolImages? = null
    private var sentToolImages: JSONArray? = null
    private var resourceOptions: (JSONObject) -> Unit = {}

    init { createBrowser() }

    private fun restartBrowser() {
        if (disposed) return
        stepReads.reset()
        ready = false; port?.close(); port = null
        browser?.let { removeView(it); it.destroy() }; browser = null
        recoveryAttempts = 0
        createBrowser()
    }

    private fun createBrowser() {
        if (disposed) return
        loadFailed = false; showInitialMessage()
        handler.removeCallbacks(loadTimeout); handler.postDelayed(loadTimeout, 10_000)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        browser = WebView(context).also { view ->
            view.settings.apply {
                javaScriptEnabled = true
                allowFileAccess = false
                allowContentAccess = false
                domStorageEnabled = false
                setSupportMultipleWindows(false)
                javaScriptCanOpenWindowsAutomatically = false
                mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
                textZoom = 100
            }
            view.setBackgroundColor(android.graphics.Color.TRANSPARENT)
            view.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse = localAsset(request.url)
                override fun onPageFinished(view: WebView, url: String) {
                    if (view !== browser || url != PAGE) return
                    stepReads.reset(); port?.close()
                    val channel = view.createWebMessageChannel()
                    port = channel[0]
                    ready = false
                    projection.reset()
                    channel[0].setWebMessageCallback(object : WebMessagePort.WebMessageCallback() {
                        override fun onMessage(receivingPort: WebMessagePort, message: WebMessage) {
                            if (receivingPort !== port || disposed) return
                            val data = message.data ?: return
                            if (data.length > MobileMessagePresentation.MAX_CLIPBOARD_PAYLOAD_BYTES) return
                            runCatching { receive(JSONObject(data)) }
                        }
                    })
                    view.postWebMessage(WebMessage("lexora-reader", arrayOf(channel[1])), Uri.parse(ORIGIN))
                }
                override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                    if (view === browser) {
                        stepReads.reset(); ready = false; port?.close(); port = null
                        removeView(view); view.destroy(); browser = null
                        if (recoveryAttempts++ == 0) post { createBrowser() }
                        else showLoadFailure()
                    }
                    return true
                }
            }
            removeView(status)
            addView(view, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
            addView(status, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
            view.loadUrl(PAGE)
        }
    }

    private fun localAsset(uri: Uri): WebResourceResponse {
        avatars?.asset(uri)?.let { return it }
        artifacts?.asset(uri)?.let { return it }
        val path = uri.path.orEmpty()
        val valid = uri.scheme == "https" && uri.host == "appassets.androidplatform.net" && uri.port == -1 &&
            path.startsWith("/reader/") && path.split('/').none { it == ".." || it == "." } && !path.contains('\\')
        val mime = when (path.substringAfterLast('.')) {
            "html" -> "text/html"; "js" -> "application/javascript"; "css" -> "text/css"
            "webp" -> "image/webp"; "svg" -> "image/svg+xml";
            "woff2" -> "font/woff2"; "woff" -> "font/woff"; "ttf" -> "font/ttf"
            else -> null
        }
        if (valid && mime != null) {
            runCatching { return WebResourceResponse(mime, if (mime.startsWith("font/") || mime.startsWith("image/")) null else "UTF-8", context.assets.open(path.removePrefix("/"))) }
        }
        return WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
    }

    fun update(
        messages: List<JSONObject>, topic: String, details: Map<String, MobileMessageDetail>, runs: List<JSONObject>,
        dark: Boolean, fontScale: Float, onMessageAction: (JSONObject) -> Unit, onResource: (JSONObject) -> Unit, onLoadDetail: (JSONObject) -> Unit,
        onQuickAction: (JSONObject, String) -> Unit = { _, _ -> },
        language: String = "zh",
        transcripts: Map<String, JSONObject> = emptyMap(),
        onLoadTranscript: (String, Boolean) -> Unit = { _, _ -> },
        resultRunId: String? = null,
        onReadResult: (String) -> Unit = {},
        avatarContext: ReaderAvatarContext? = null,
        anchorMessageId: String? = null,
        anchorRequestId: String? = null,
        hasLaterMessages: Boolean = false,
        onLatest: () -> Unit = {},
        artifactContext: ReaderArtifactContext? = null,
        onResourceActions: (JSONObject) -> Unit = onResource,
        branches: List<JSONObject> = emptyList(),
        selectedBranchId: String? = null,
        onBranch: (JSONObject) -> Unit = {},
        onMessageMenu: ((JSONObject, IntRect?, Boolean) -> Unit)? = null,
        turn: ReaderTurnContext = ReaderTurnContext(),
        onOlder: (Boolean) -> Unit = {},
    ) {
        if (avatarContext != null) {
            val created = avatars == null
            if (created) avatars = ReaderAvatars(context, avatarContext.schemas) { schedulePublish() }
            if (created || this.messages !== messages || this.runs !== runs) avatarAuthors =
                (messages.mapNotNull { it.optJSONObject("author")?.optString("id")?.takeIf(String::isNotBlank) } +
                    runs.mapNotNull { it.optString("buddyId").takeIf(String::isNotBlank) }).toSet()
            avatars?.update(avatarContext.partition, topic, avatarContext.client, avatarAuthors)
        } else if (avatars != null) { avatars?.close(); avatars = null; schedulePublish() }
        if (this.messages !== messages || this.turn.groups !== turn.groups || this.turn.enabled != turn.enabled)
            turnRunIds = if (turn.enabled) buildSet {
                for (message in messages) (message.opt("runId") as? String)?.let(::add)
                for (group in turn.groups) add(group.getString("runId"))
            } else emptySet()
        if (artifactContext != null) {
            if (artifacts == null) {
                artifacts = ReaderArtifacts(context) { toolImages?.invalidateImages(); schedulePublish() }
                toolImages = ReaderToolImages(artifacts!!) { schedulePublish() }
            }
            artifacts?.update(topic, artifactContext, runs, turnRunIds)
            toolImages?.update(topic, artifactContext, runs, transcripts)
        } else if (artifacts != null) {
            toolImages?.close(); toolImages = null; artifacts?.close(); artifacts = null; schedulePublish()
        }
        selectBranch = onBranch
        messageMenu = onMessageMenu
        resourceOptions = onResourceActions
        loadTranscript = onLoadTranscript
        older = onOlder
        latest = onLatest
        if (topic != this.topic || this.turn.target != turn.target || !turn.enabled) stepReads.reset()
        steps.update(topic, turn, artifactContext)
        val turnChanged = this.turn.enabled != turn.enabled || this.turn.groups !== turn.groups || this.turn.historyLoading != turn.historyLoading ||
            this.turn.historyAvailable != turn.historyAvailable || this.turn.historyError != turn.historyError || this.turn.historyPage != turn.historyPage || this.turn.client !== turn.client ||
            this.turn.latestLoading != turn.latestLoading || this.turn.latestError != turn.latestError
        this.turn = turn
        readResult = onReadResult
        quickAction = onQuickAction
        messageAction = onMessageAction; resourceAction = onResource; detailAction = onLoadDetail
        if (!turnChanged && this.messages === messages && this.topic == topic && this.details === details && this.runs === runs && this.dark == dark && this.fontScale == fontScale && this.language == language && this.transcripts === transcripts && this.resultRunId == resultRunId && this.anchorMessageId == anchorMessageId && this.anchorRequestId == anchorRequestId && this.hasLaterMessages == hasLaterMessages && this.branches === branches && this.selectedBranchId == selectedBranchId) return
        this.branches = branches
        this.selectedBranchId = selectedBranchId
        this.anchorMessageId = anchorMessageId
        this.anchorRequestId = anchorRequestId
        this.hasLaterMessages = hasLaterMessages
        this.resultRunId = resultRunId
        this.transcripts = transcripts
        this.messages = messages; this.topic = topic; this.details = details; this.runs = runs
        this.dark = dark; this.fontScale = fontScale; this.language = language
        if (!ready && !loadFailed) showInitialMessage()
        schedulePublish()
    }

    private fun schedulePublish() { if (!disposed && !scheduled) { scheduled = true; handler.postDelayed(flush, 32) } }

    override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
        super.onWindowFocusChanged(hasWindowFocus)
        if (ready && !disposed) publish()
    }

    private fun publish(bodyPage: JSONObject? = null) {
        if (!ready || disposed) return
        val snapshot = ReaderSnapshot(messages, topic, details, runs, transcripts, dark, fontScale, language,
            resultRunId?.takeIf { hasWindowFocus() && isShown }, avatars?.sources ?: emptyMap(), anchorMessageId, anchorRequestId, hasLaterMessages, artifacts?.imageEpoch, turn, steps.wire)
        val update = projection.encode(snapshot, { MobileTheme.palette(context, dark) }, { MobileTheme.typography(context) }) {
            artifacts?.photoState(it) ?: ReaderPhotoState("unavailable")
        }
        if (update.optBoolean("reset") || branches !== sentBranches || selectedBranchId != sentSelectedBranchId) {
            update.put("branches", JSONArray(branches)).put("selectedBranchId", selectedBranchId ?: JSONObject.NULL)
            sentBranches = branches; sentSelectedBranchId = selectedBranchId
        }
        val outputs = artifacts?.wire()
        if (update.optBoolean("reset") || outputs !== sentOutputs) { update.put("outputs", outputs ?: JSONObject()); sentOutputs = outputs }
        val imageState = toolImages?.wire()
        if (update.optBoolean("reset") || imageState !== sentToolImages) { update.put("toolImages", imageState ?: JSONArray()); sentToolImages = imageState }
        if (bodyPage != null) update.put("bodyPage", bodyPage)
        port?.postMessage(WebMessage(update.toString()))
    }

    internal val readyForBenchmark: Boolean get() = BuildConfig.PROBE_ENABLED && ready && isShown && hasWindowFocus()
    internal fun beginFrameProbe() {
        if (!BuildConfig.PROBE_ENABLED) return
        browser?.evaluateJavascript("window.lexoraFrameProbe={values:[],previous:performance.now(),active:true};function sample(t){const p=window.lexoraFrameProbe;if(!p.active)return;if(p.values.length<20000)p.values.push(t-p.previous);p.previous=t;requestAnimationFrame(sample)};requestAnimationFrame(sample)", null)
    }
    internal fun finishFrameProbe(complete: (JSONObject) -> Unit) {
        if (!BuildConfig.PROBE_ENABLED) return
        browser?.evaluateJavascript("(()=>{const p=window.lexoraFrameProbe;p.active=false;const v=p.values.slice(1).sort((a,b)=>a-b);return {rafFrameP95Ms:v[Math.floor((v.length-1)*.95)],frameSamples:v.length,rafOver64Ms:v.filter(n=>n>64).length,renderedMessages:document.querySelectorAll('.reader-entry').length,completed:document.body.innerText.includes('持续输出结束标记')}})()") { value -> complete(JSONObject(value)) }
    }

    private var bodyPageReads = 0
    private fun readBodyPage(action: JSONObject) {
        val id = action.getString("id"); val revision = action.getString("revision")
        val direction = if (action.getString("action") == "body-after") "after" else "before"
        val offset = action.getLong(direction)
        val response = JSONObject().put("id", id).put("revision", revision).put(direction, offset).put("page", JSONObject.NULL)
        val source = messages.firstOrNull { it.optString("id") == id && it.optString("role") == "assistant" }
        val commentary = revision.startsWith("c:")
        val range = if (commentary) source?.optJSONObject("commentary")?.optJSONObject("range") else source?.optJSONObject("textRange")
        val saved = commentary || revision.startsWith("s:")
        val method = if (saved) "conversations.readSavedText" else "conversations.readLiveText"
        val target = turn.target; val client = turn.client
        val validRevision = if (saved) range?.optString("revision") == revision else direction == "before" &&
            (revision.toLongOrNull() ?: -1L) in 1..(range?.optString("revision")?.toLongOrNull() ?: 0L)
        if (!turn.enabled || target == null || client?.supports(method) != true || range == null || !validRevision ||
            offset !in 0..range.getLong("total") || bodyPageReads >= 4) { publish(response); return }
        val origin = port; val scope = topic; val run = source?.optString("runId").orEmpty()
        val params = target.params().put("messageId", id).put("revision", revision)
        if (saved) params.put("direction", direction).put("offset", offset) else params.put("runId", run).put("before", offset)
        bodyPageReads++
        java.util.concurrent.CompletableFuture.supplyAsync { client.call(method, params) }.whenComplete { page, _ -> handler.post {
            bodyPageReads--
            if (disposed || origin !== port || scope != topic) return@post
            if (turn.client === client && turn.target == target && messages.any {
                val current = if (commentary) it.optJSONObject("commentary")?.optJSONObject("range") else it.optJSONObject("textRange")
                it.optString("id") == id && it.optString("runId") == run && current != null && (!saved || current.optString("revision") == revision)
            }) {
                response.put("page", page ?: JSONObject.NULL)
            }
            publish(response)
        } }
    }

    private var language = "zh"
    private var quickAction: (JSONObject, String) -> Unit = { _, _ -> }

    private fun receive(data: JSONObject) {
        if (!protocol.valid(data, protocol.document.getJSONObject("action"))) return
        if (data.optString("action") == "ready") { ready = true; handler.removeCallbacks(loadTimeout); status.visibility = View.GONE; publish(); return }
        if (data.optString("topic") != topic) return
        if (turn.enabled && data.optString("action") in setOf("photo-thumbnail", "artifact-thumbnail", "tool-image")) return
        if (data.optString("action") == "branch") {
            branches.firstOrNull { it.optString("id") == data.optString("branchId") }?.let(selectBranch)
            return
        }
        if (data.optString("action") in setOf("body-before", "body-after")) { readBodyPage(data); return }
        if (data.optString("action") == "latest") {
            if (hasLaterMessages && !turn.latestLoading) latest()
            return
        }
        if (data.optString("action") == "older") {
            val retry = data.optBoolean("retry")
            if (turn.historyAvailable && !turn.historyLoading && (turn.historyError == null || retry)) older(retry)
            return
        }
        if (data.optString("action") == "stop-step-detail") { stepReads.stop(data.getString("requestId")); return }
        if (data.optString("action") == "read-step-detail") {
            val origin = port; val binding = turn; val scope = topic
            val group = data.getString("groupId")
            stepReads.read(data, binding, {
                !disposed && isShown && windowVisibility == View.VISIBLE && origin === port && scope == topic && turn.enabled &&
                    turn.target == binding.target && turn.client === binding.client && steps.hasPendingStep(data.getString("runId"), group, data.getString("stepId"))
            }) { reply ->
                if (!disposed && scope == topic && origin === port) {
                    reply.optJSONObject("result")?.let { steps.settle(group, it) }
                    origin?.postMessage(WebMessage(reply.toString()))
                }
            }
            return
        }
        if (data.optString("action") == "activity-steps") {
            steps.request(data.getString("groupId"), data.getString("runId"), data.opt("cursor") as? String)
            return
        }
        if (data.optString("action") == "read-result") {
            val id = data.optString("runId")
            if (id == resultRunId && isShown && hasWindowFocus() && runs.any { it.optString("id") == id && it.optString("status") in setOf("completed", "failed", "cancelled") }) readResult(id)
            return
        }
        if (data.optString("action") in setOf("outputs", "artifact", "artifact-actions", "artifact-thumbnail")) {
            val runId = data.optString("runId")
            if (runId !in turnRunIds && runs.none { it.optString("id") == runId }) return
            when (data.getString("action")) {
                "outputs" -> artifacts?.request(runId, data.optString("retry") == "true")
                "artifact-thumbnail" -> artifacts?.thumbnail(runId, data.optString("resourceId"))
                else -> artifacts?.resource(runId, data.optString("resourceId"))?.let { if (data.getString("action") == "artifact") resourceAction(it) else resourceOptions(it) }
            }
            return
        }
        if (data.optString("action") in setOf("tool-image", "tool-image-preview")) {
            val id = ReaderToolImageId.from(data)
            if (data.getString("action") == "tool-image") toolImages?.request(id, data.optString("retry") == "true")
            else toolImages?.resource(id)?.let(resourceAction)
            return
        }
        val message = messages.firstOrNull { it.optString("id") == data.optString("id") }
        if (data.optString("action") == "transcript") {
            val id = data.optString("runId")
            if (!turn.enabled && runs.any { it.optString("id") == id }) loadTranscript(id, data.optString("retry") == "true")
            return
        }
        when (data.optString("action")) {
            "message" -> message?.let { source ->
                val anchor = data.optJSONObject("anchor")?.let { rect ->
                    val location = IntArray(2)
                    getLocationInWindow(location)
                    val left = location[0] + (rect.getDouble("x") * width).toInt()
                    val top = location[1] + (rect.getDouble("y") * height).toInt()
                    IntRect(left, top, left + (rect.getDouble("width") * width).toInt(), top + (rect.getDouble("height") * height).toInt())
                }
                messageMenu?.invoke(source, anchor, data.optBoolean("contextual")) ?: messageAction(source)
            }
            "edit", "regenerate", "followup" -> message?.let { quickAction(it, data.getString("action")) }
            "detail" -> if (message != null) detailAction(message) else steps.detail(data.getString("id"))
            "photo-thumbnail" -> {
                val resource = ReaderMessagePhotos.resolve(message, data) ?: return
                artifacts?.requestPhoto(resource, data.optBoolean("retry"))
            }
            "resource" -> {
                if (data.has("revision")) {
                    ReaderMessagePhotos.resolve(message, data)?.takeIf { MobileReadingPolicy.resource(it).available }?.let(resourceAction)
                    return
                }
                if (message == null) {
                    steps.resource(data.getString("id"), data.getString("resourceId"))?.let(resourceAction)
                    return
                }
                val presentation = MobileMessagePresentation.message(message)
                val detail = MobileMessagePresentation.matchingDetail(message, details[presentation.id])
                val resource = (presentation.resources + listOfNotNull(detail?.resource)).firstOrNull { it.optString("resourceId") == data.optString("resourceId") }
                resource?.let(resourceAction)
            }
            "copy" -> {
                if (message == null && runs.none { it.optString("id") == data.optString("runId") }) return
                val text = data.optString("text")
                if (MobileMessagePresentation.canCopy(text)) {
                    (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).setPrimaryClip(ClipData.newPlainText("Lexora", text))
                    if (message != null && data.optString("feedback") == "message") {
                        port?.postMessage(WebMessage(JSONObject().put("type", "copied").put("topic", topic).put("id", message.getString("id")).toString()))
                    } else Toast.makeText(context, mobileText(R.string.copied), Toast.LENGTH_SHORT).show()
                }
            }
            "link" -> MobileReadingPolicy.webLink(data.optString("href"))?.let { href ->
                runCatching { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(href))) }
                    .onFailure { Toast.makeText(context, mobileText(R.string.mobile_could_not_open_link), Toast.LENGTH_SHORT).show() }
            }
        }
    }

    fun dispose() {
        disposed = true; ready = false; stepReads.reset(); steps.close()
        avatars?.close(); avatars = null
        toolImages?.close(); toolImages = null
        artifacts?.close(); artifacts = null
        handler.removeCallbacks(flush); handler.removeCallbacks(loadTimeout); port?.close(); port = null
        browser?.let { removeView(it); it.destroy() }; browser = null
    }

    companion object {
        const val ORIGIN = "https://appassets.androidplatform.net"
        const val PAGE = "$ORIGIN/reader/index.html"
    }
}
