package app.uselexora.mobile.preview

import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText
import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.*
import android.widget.Toast
import app.uselexora.mobile.ui.MobileAppearance
import org.json.JSONObject
import java.io.ByteArrayInputStream

@SuppressLint("SetJavaScriptEnabled")
internal class PreviewDocumentView(context: Context, private val text: String, private val canQuote: Boolean, private val quote: (String) -> Unit) : WebView(context) {
    private var port: WebMessagePort? = null
    private var released = false
    init {
        settings.apply {
            javaScriptEnabled = true
            allowFileAccess = false; allowContentAccess = false; domStorageEnabled = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            javaScriptCanOpenWindowsAutomatically = false; setSupportMultipleWindows(false)
        }
        webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest) = true
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse {
                val uri = request.url
                val path = uri.path.orEmpty()
                if (uri.scheme == "https" && uri.host == HOST && uri.port == -1 && uri.userInfo == null && path.startsWith("/reader/") && path.split('/').none { it == ".." || it == "." } && !path.contains('\\')) {
                    val mime = when (path.substringAfterLast('.')) {
                        "html" -> "text/html"; "js" -> "application/javascript"; "css" -> "text/css"
                        "woff2" -> "font/woff2"; "woff" -> "font/woff"; "ttf" -> "font/ttf"
                        else -> null
                    }
                    if (mime != null) runCatching { return WebResourceResponse(mime, "UTF-8", context.assets.open(path.removePrefix("/"))) }
                }
                return WebResourceResponse("text/plain", "UTF-8", 403, "Blocked", emptyMap(), ByteArrayInputStream(ByteArray(0)))
            }
            override fun onPageFinished(view: WebView, url: String) {
                if (released || url != PAGE) return
                port?.close()
                val channel = createWebMessageChannel()
                port = channel[0]
                channel[0].setWebMessageCallback(object : WebMessagePort.WebMessageCallback() {
                    override fun onMessage(receivingPort: WebMessagePort, message: WebMessage) {
                        if (released || receivingPort !== port) return
                        val raw = message.data ?: return
                        if (raw.length > 400000) return
                        runCatching {
                            val value = JSONObject(raw)
                            val body = value.optString("text")
                            when (value.optString("action")) {
                                "ready" -> {
                                    val dark = MobileAppearance.isDark(resources.configuration.uiMode and android.content.res.Configuration.UI_MODE_NIGHT_MASK == android.content.res.Configuration.UI_MODE_NIGHT_YES)
                                    val appearance = JSONObject(context.assets.open("reader/appearance.json").bufferedReader().use { it.readText() }).getJSONObject(if (dark) "dark" else "light").getJSONObject("variables")
                                    receivingPort.postMessage(WebMessage(JSONObject().put("text", text).put("dark", dark).put("language", MobileAppearance.language).put("fontScale", resources.configuration.fontScale.coerceIn(.5f, 3f)).put("appearance", appearance).put("canQuote", canQuote).put("labels", JSONObject().put("body", mobileText(R.string.document_body)).put("quote", mobileText(R.string.quote_selection))).toString()))
                                }
                                "copy" -> if (body.length <= PreviewPolicy.MAX_TEXT_CHARS) {
                                    context.getSystemService(ClipboardManager::class.java).setPrimaryClip(ClipData.newPlainText(mobileText(R.string.document_body), body))
                                    Toast.makeText(context, mobileText(R.string.copied), Toast.LENGTH_SHORT).show()
                                }
                                "quote" -> if (canQuote && body.isNotBlank() && body.length <= 8000) quote(body)
                                "link" -> {
                                    val uri = Uri.parse(body)
                                    if (uri.scheme in setOf("http", "https") && !uri.host.isNullOrBlank()) context.startActivity(Intent(Intent.ACTION_VIEW, uri))
                                }
                            }
                        }
                    }
                })
                postWebMessage(WebMessage("lexora-document", arrayOf(channel[1])), Uri.parse("https://$HOST"))
            }
            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                release()
                Toast.makeText(context, mobileText(R.string.file_display_interrupted), Toast.LENGTH_LONG).show()
                return true
            }
        }
        loadUrl(PAGE)
    }
    fun release() {
        if (released) return
        released = true; port?.close(); port = null
        (parent as? android.view.ViewGroup)?.removeView(this)
        destroy()
    }
    companion object {
        const val HOST = "lexora-document.invalid"
        const val PAGE = "https://$HOST/reader/document.html"
    }
}
