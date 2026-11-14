package app.uselexora.mobile.preview

import app.uselexora.mobile.i18n.MobileStrings
import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText
import android.app.Activity
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.text.TextUtils
import android.view.Gravity
import android.view.View
import android.widget.*
import androidx.core.content.FileProvider
import java.io.File
import java.util.concurrent.Executors

class PreviewActivity : Activity() {
    private lateinit var file: File
    private lateinit var kind: PreviewKind
    private lateinit var status: TextView
    private lateinit var content: FrameLayout
    private lateinit var pages: TextView
    private lateinit var previous: Button
    private lateinit var next: Button
    private var name = ""
    private var mime = ""
    private var page = 0
    private var pageCount = 1
    private var image: Bitmap? = null
    private var imageView: ZoomImageView? = null
    private var client: PreviewClient? = null
    private var documentView: PreviewDocumentView? = null
    private var generation = 0L
    private var active = false
    private val io = Executors.newSingleThreadExecutor()
    override fun attachBaseContext(base: android.content.Context) {
        super.attachBaseContext(MobileStrings.localizedContext(base))
    }
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        name = intent.getStringExtra("name") ?: mobileText(R.string.preview_title)
        mime = intent.getStringExtra("mime") ?: ""
        try {
            file = PreviewPolicy.exportedFile(File(filesDir, "exports"), intent.getStringExtra("path") ?: "")
            kind = PreviewPolicy.kind(name, mime) ?: throw PreviewFailure("unsupported")
        } catch (_: Exception) { finish(); return }
        page = state?.getInt("page") ?: 0
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setBackgroundColor(Color.rgb(247, 248, 244)) }
        root.setOnApplyWindowInsetsListener { view, insets -> view.setPadding(dp(12), insets.systemWindowInsetTop, dp(12), insets.systemWindowInsetBottom); insets }
        val toolbar = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        toolbar.addView(button(mobileText(R.string.label_back)) { finish() })
        toolbar.addView(TextView(this).apply { text = name; textSize = 18f; maxLines = 2; ellipsize = TextUtils.TruncateAt.END }, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(toolbar)
        status = TextView(this).apply { id = STATUS_ID; textSize = 13f; setPadding(dp(8), dp(8), dp(8), dp(8)); accessibilityLiveRegion = View.ACCESSIBILITY_LIVE_REGION_POLITE }
        root.addView(status)
        content = FrameLayout(this).apply { setBackgroundColor(Color.WHITE) }
        root.addView(content, LinearLayout.LayoutParams(-1, 0, 1f))
        val navigation = LinearLayout(this).apply { gravity = Gravity.CENTER_VERTICAL }
        previous = button(mobileText(R.string.previous_page)) { render(page - 1) }.apply { id = PREVIOUS_ID }
        next = button(mobileText(R.string.next_page)) { render(page + 1) }.apply { id = NEXT_ID }
        pages = TextView(this).apply { id = PAGE_ID; gravity = Gravity.CENTER; textSize = 14f }
        navigation.addView(previous); navigation.addView(pages, LinearLayout.LayoutParams(0, -2, 1f)); navigation.addView(next)
        navigation.visibility = if (kind == PreviewKind.PDF) View.VISIBLE else View.GONE
        root.addView(navigation)
        val actions = LinearLayout(this)
        if (kind != PreviewKind.TEXT) {
            actions.addView(button(mobileText(R.string.zoom_out)) { imageView?.zoomBy(0.75f) }, LinearLayout.LayoutParams(0, -2, 1f))
            actions.addView(button(mobileText(R.string.zoom_in)) { imageView?.zoomBy(1.5f) }, LinearLayout.LayoutParams(0, -2, 1f))
        }
        actions.addView(button(mobileText(R.string.save_file)) { startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).setType(mime).addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE, name), SAVE_REQUEST) }, LinearLayout.LayoutParams(0, -2, 1f))
        actions.addView(button(mobileText(R.string.share_file)) {
            val uri = FileProvider.getUriForFile(this, "$packageName.files", file, name)
            try { startActivity(Intent.createChooser(Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION), mobileText(R.string.share_file_title))) }
            catch (_: android.content.ActivityNotFoundException) { status.text = mobileText(R.string.no_share_app) }
        }, LinearLayout.LayoutParams(0, -2, 1f))
        root.addView(actions)
        if (intent.getBooleanExtra("canFollowup", false)) root.addView(button(mobileText(R.string.file_followup)) { followup("") }.apply { id = FOLLOWUP_ID }, LinearLayout.LayoutParams(-1, -2))
        setContentView(root)
    }
    override fun onStart() {
        super.onStart()
        if (!::file.isInitialized || isFinishing) return
        active = true
        client = PreviewClient(this)
        render(page)
    }
    private fun render(index: Int) {
        if (!active || index < 0) return
        val renderer = client ?: return
        val request = ++generation
        previous.isEnabled = false; next.isEnabled = false
        status.text = mobileText(R.string.opening_file)
        io.execute {
            try {
                val rendered = renderer.render(file, kind, index)
                runOnUiThread {
                    if (!active || request != generation) { rendered.bitmap?.recycle(); return@runOnUiThread }
                    page = index; pageCount = rendered.pageCount
                    content.removeAllViews(); imageView = null; image?.recycle(); image = rendered.bitmap
                    documentView?.release(); documentView = null
                    if (rendered.text != null && (mime.substringBefore(';') == "text/markdown" || name.endsWith(".md", true) || name.endsWith(".markdown", true))) {
                        documentView = PreviewDocumentView(this, rendered.text, intent.getBooleanExtra("canFollowup", false), ::followup).also { content.addView(it, FrameLayout.LayoutParams(-1, -1)) }
                    } else if (rendered.text != null) {
                        val text = TextView(this).apply { id = TEXT_ID; textSize = 16f; setPadding(dp(16), dp(12), dp(16), dp(12)); setTextIsSelectable(true); text = rendered.text
                            if (intent.getBooleanExtra("canFollowup", false)) customSelectionActionModeCallback = object : android.view.ActionMode.Callback {
                                override fun onCreateActionMode(mode: android.view.ActionMode, menu: android.view.Menu): Boolean { menu.add(0, QUOTE_ID, 0, mobileText(R.string.quote_action)); return true }
                                override fun onPrepareActionMode(mode: android.view.ActionMode, menu: android.view.Menu) = false
                                override fun onActionItemClicked(mode: android.view.ActionMode, item: android.view.MenuItem): Boolean {
                                    if (item.itemId != QUOTE_ID) return false
                                    val begin = minOf(selectionStart, selectionEnd).coerceAtLeast(0)
                                    val end = maxOf(selectionStart, selectionEnd).coerceAtMost(text.length)
                                    if (end > begin && end - begin <= 8000) followup(text.subSequence(begin, end).toString())
                                    else status.text = mobileText(R.string.quote_limit)
                                    return true
                                }
                                override fun onDestroyActionMode(mode: android.view.ActionMode) {}
                            }
                        }
                        content.addView(ScrollView(this).apply { addView(text) })
                    } else {
                        imageView = ZoomImageView(this).apply { contentDescription = mobileText(R.string.preview_page_description, name, page + 1); display(rendered.bitmap) }
                        content.addView(imageView, FrameLayout.LayoutParams(-1, -1))
                    }
                    status.text = if (rendered.truncated) mobileText(R.string.preview_truncated, PreviewPolicy.MAX_TEXT_CHARS) else if (kind == PreviewKind.TEXT) mobileText(R.string.readonly_text) else mobileText(R.string.readonly_preview)
                    pages.text = "${page + 1} / $pageCount"
                    previous.isEnabled = page > 0; next.isEnabled = page + 1 < pageCount
                }
            } catch (error: Exception) { runOnUiThread {
                if (active && request == generation) {
                    status.text = when ((error as? PreviewFailure)?.reason) {
                        "protected" -> mobileText(R.string.protected_file)
                        "timeout" -> mobileText(R.string.preview_timeout)
                        else -> mobileText(R.string.preview_failed)
                    }
                    previous.isEnabled = page > 0; next.isEnabled = page + 1 < pageCount
                }
            } }
        }
    }
    @Deprecated("Android activity result compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != SAVE_REQUEST) return
        val uri = data?.data
        if (resultCode != RESULT_OK || uri == null) { status.text = mobileText(R.string.save_cancelled); return }
        io.execute {
            val saved = runCatching { contentResolver.openOutputStream(uri, "w").use { target -> requireNotNull(target); file.inputStream().use { it.copyTo(target) }; target.flush() } }.isSuccess
            runOnUiThread { if (!isDestroyed) status.text = if (saved) mobileText(R.string.file_saved) else mobileText(R.string.file_save_failed) }
        }
    }
    override fun onSaveInstanceState(state: Bundle) { state.putInt("page", page); super.onSaveInstanceState(state) }
    private fun followup(quote: String) {
        setResult(RESULT_OK, Intent().putExtra("quote", quote))
        finish()
    }
    override fun onStop() {
        documentView?.release(); documentView = null
        active = false; generation++; client?.close(); client = null
        if (::content.isInitialized) content.removeAllViews()
        imageView = null; image?.recycle(); image = null
        super.onStop()
    }
    override fun onDestroy() { io.shutdownNow(); super.onDestroy() }
    private fun button(label: String, action: () -> Unit) = Button(this).apply { text = label; textSize = 14f; isAllCaps = false; minWidth = 0; setPadding(dp(12), 0, dp(12), 0); setOnClickListener { action() } }
    private fun dp(value: Int) = (resources.displayMetrics.density * value).toInt()
    companion object { const val FOLLOWUP_ID = 0x2206; const val QUOTE_ID = 0x2207; const val STATUS_ID = 0x2201; const val TEXT_ID = 0x2202; const val PAGE_ID = 0x2203; const val NEXT_ID = 0x2204; const val PREVIOUS_ID = 0x2205; private const val SAVE_REQUEST = 4101 }
}
