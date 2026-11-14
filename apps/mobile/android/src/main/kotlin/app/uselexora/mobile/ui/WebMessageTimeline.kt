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
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.viewinterop.AndroidView
import app.uselexora.mobile.BuildConfig
import app.uselexora.mobile.protocol.MobileMessageDetail
import app.uselexora.mobile.protocol.MobileMessagePresentation
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
) {
    val dark = MobileAppearance.isDark(isSystemInDarkTheme())
    val fontScale = LocalConfiguration.current.fontScale
    val language = MobileAppearance.language
    AndroidView(
        factory = { ReaderView(it) }, modifier = modifier.testTag("message-list"),
        onRelease = { it.dispose() },
        update = { it.update(messages, topic, details, runs, dark, fontScale, onMessageAction, onResource, onLoadDetail, onQuickAction, language, transcripts, onLoadTranscript, resultRunId, onReadResult, avatarContext) },
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
    private var dark = false
    private var fontScale = 1f
    private var messageAction: (JSONObject) -> Unit = {}
    private var resourceAction: (JSONObject) -> Unit = {}
    private var detailAction: (JSONObject) -> Unit = {}
    private var scheduled = false
    private val flush = Runnable { scheduled = false; publish() }
    private val status = TextView(context).apply {
        textSize = 16f; gravity = Gravity.CENTER
        setTextColor(android.graphics.Color.rgb(91, 116, 106))
        setPadding(24, 24, 24, 24)
        setOnClickListener { restartBrowser() }
    }
    private val loadTimeout = Runnable { if (!ready && !disposed) status.text = mobileText(R.string.mobile_conversation_display_unavailable_tap_to_retry) }
    private var recoveryAttempts = 0
    private var resultRunId: String? = null
    private var readResult: (String) -> Unit = {}
    @Volatile private var avatars: ReaderAvatars? = null
    private var avatarAuthors = emptySet<String>()

    init { createBrowser() }

    private fun restartBrowser() {
        if (disposed) return
        ready = false; port?.close(); port = null
        browser?.let { removeView(it); it.destroy() }; browser = null
        recoveryAttempts = 0
        createBrowser()
    }

    private fun createBrowser() {
        if (disposed) return
        status.text = mobileText(R.string.mobile_opening_conversation); status.visibility = View.VISIBLE
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
                    port?.close()
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
                        ready = false; port?.close(); port = null
                        removeView(view); view.destroy(); browser = null
                        if (recoveryAttempts++ == 0) post { createBrowser() }
                        else { status.visibility = View.VISIBLE; status.text = mobileText(R.string.mobile_conversation_display_unavailable_tap_to_retry) }
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
    ) {
        if (avatarContext != null) {
            val created = avatars == null
            if (created) avatars = ReaderAvatars(context, avatarContext.schemas) { schedulePublish() }
            if (created || this.messages !== messages || this.runs !== runs) avatarAuthors =
                (messages.mapNotNull { it.optJSONObject("author")?.optString("id")?.takeIf(String::isNotBlank) } +
                    runs.mapNotNull { it.optString("buddyId").takeIf(String::isNotBlank) }).toSet()
            avatars?.update(avatarContext.partition, topic, avatarContext.client, avatarAuthors)
        } else if (avatars != null) { avatars?.close(); avatars = null; schedulePublish() }
        loadTranscript = onLoadTranscript
        readResult = onReadResult
        quickAction = onQuickAction
        messageAction = onMessageAction; resourceAction = onResource; detailAction = onLoadDetail
        if (this.messages === messages && this.topic == topic && this.details === details && this.runs === runs && this.dark == dark && this.fontScale == fontScale && this.language == language && this.transcripts === transcripts && this.resultRunId == resultRunId) return
        this.resultRunId = resultRunId
        this.transcripts = transcripts
        this.messages = messages; this.topic = topic; this.details = details; this.runs = runs
        this.dark = dark; this.fontScale = fontScale; this.language = language
        schedulePublish()
    }

    private fun schedulePublish() { if (!disposed && !scheduled) { scheduled = true; handler.postDelayed(flush, 32) } }

    override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
        super.onWindowFocusChanged(hasWindowFocus)
        if (ready && !disposed) publish()
    }

    private fun publish() {
        if (!ready || disposed) return
        val snapshot = ReaderSnapshot(messages, topic, details, runs, transcripts, dark, fontScale, language,
            resultRunId?.takeIf { hasWindowFocus() && isShown }, avatars?.sources ?: emptyMap())
        val update = projection.encode(snapshot, { MobileTheme.palette(context, dark) }, { MobileTheme.typography(context) })
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

    private var language = "zh"
    private var quickAction: (JSONObject, String) -> Unit = { _, _ -> }

    private fun receive(data: JSONObject) {
        if (!protocol.valid(data, protocol.document.getJSONObject("action"))) return
        if (data.optString("action") == "ready") { ready = true; handler.removeCallbacks(loadTimeout); status.visibility = View.GONE; publish(); return }
        if (data.optString("topic") != topic) return
        if (data.optString("action") == "read-result") {
            val id = data.optString("runId")
            if (id == resultRunId && isShown && hasWindowFocus() && runs.any { it.optString("id") == id && it.optString("status") in setOf("completed", "failed", "cancelled") }) readResult(id)
            return
        }
        val message = messages.firstOrNull { it.optString("id") == data.optString("id") }
        if (data.optString("action") == "transcript") {
            val id = data.optString("runId")
            if (runs.any { it.optString("id") == id }) loadTranscript(id, data.optString("retry") == "true")
            return
        }
        when (data.optString("action")) {
            "message" -> message?.let(messageAction)
            "edit", "regenerate", "followup" -> message?.let { quickAction(it, data.getString("action")) }
            "detail" -> message?.let(detailAction)
            "resource" -> {
                if (message == null) return
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
        disposed = true; ready = false
        avatars?.close(); avatars = null
        handler.removeCallbacks(flush); handler.removeCallbacks(loadTimeout); port?.close(); port = null
        browser?.let { removeView(it); it.destroy() }; browser = null
    }

    companion object {
        const val ORIGIN = "https://appassets.androidplatform.net"
        const val PAGE = "$ORIGIN/reader/index.html"
    }
}
