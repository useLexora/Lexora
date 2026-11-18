package app.uselexora.mobile.preview

import app.uselexora.mobile.i18n.MobileStrings
import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText
import android.content.Intent
import android.content.ClipData
import android.content.res.Configuration
import androidx.compose.ui.graphics.toArgb
import app.uselexora.mobile.storage.DocumentExport
import app.uselexora.mobile.ui.MobileAppearance
import app.uselexora.mobile.ui.MobileTheme
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.widget.*
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.core.content.FileProvider
import app.uselexora.mobile.ui.LexoraTheme
import java.io.File
import java.util.concurrent.Executors

class PreviewActivity : ComponentActivity() {
    private lateinit var file: File
    private lateinit var kind: PreviewKind
    private lateinit var content: FrameLayout
    private var loading by mutableStateOf(true)
    private var error by mutableStateOf<String?>(null)
    private var notice by mutableStateOf<String?>(null)
    private var feedback by mutableStateOf<String?>(null)
    private var empty by mutableStateOf(false)
    private var chromeVisible by mutableStateOf(true)
    private var retryPage = 0
    private var foregroundColor = Color.BLACK
    private var name = ""
    private var mime = ""
    private var page by mutableIntStateOf(0)
    private var pageCount by mutableIntStateOf(1)
    private var image: Bitmap? = null
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
        MobileAppearance.load(this)
        val palette = MobileTheme.palette(this, MobileAppearance.isDark(resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES))
        foregroundColor = MobileTheme.color(palette, "fg").toArgb()
        content = FrameLayout(this)
        val size = file.length()
        setContent {
            LexoraTheme {
                PreviewScreen(
                    name = name, mime = mime, size = size, kind = kind, content = content,
                    loading = loading, error = error, notice = notice, empty = empty,
                    page = page, pageCount = pageCount, chromeVisible = chromeVisible,
                    canFollowup = intent.getBooleanExtra("canFollowup", false),
                    feedback = feedback, feedbackShown = { if (feedback == it) feedback = null },
                    back = ::finish, retry = { render(retryPage) }, navigate = ::render,
                    save = ::save, share = ::share, openWith = ::openWith, followup = { followup("") },
                )
            }
        }
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
        loading = true; error = null; notice = null; empty = false; chromeVisible = true
        retryPage = index
        io.execute {
            try {
                val rendered = renderer.render(file, kind, index)
                runOnUiThread {
                    if (!active || request != generation) { rendered.bitmap?.recycle(); return@runOnUiThread }
                    page = index; pageCount = rendered.pageCount
                    content.removeAllViews(); image?.recycle(); image = rendered.bitmap
                    documentView?.release(); documentView = null
                    if (rendered.text != null && (mime.substringBefore(';') == "text/markdown" || name.endsWith(".md", true) || name.endsWith(".markdown", true))) {
                        documentView = PreviewDocumentView(this, rendered.text, intent.getBooleanExtra("canFollowup", false), ::followup).also { content.addView(it, FrameLayout.LayoutParams(-1, -1)) }
                    } else if (rendered.text != null) {
                        val text = TextView(this).apply { id = TEXT_ID; textSize = 16f; setTextColor(foregroundColor); setPadding(dp(16), dp(12), dp(16), dp(12)); setTextIsSelectable(true); text = rendered.text
                            if (intent.getBooleanExtra("canFollowup", false)) customSelectionActionModeCallback = object : android.view.ActionMode.Callback {
                                override fun onCreateActionMode(mode: android.view.ActionMode, menu: android.view.Menu): Boolean { menu.add(0, QUOTE_ID, 0, mobileText(R.string.quote_action)); return true }
                                override fun onPrepareActionMode(mode: android.view.ActionMode, menu: android.view.Menu) = false
                                override fun onActionItemClicked(mode: android.view.ActionMode, item: android.view.MenuItem): Boolean {
                                    if (item.itemId != QUOTE_ID) return false
                                    val begin = minOf(selectionStart, selectionEnd).coerceAtLeast(0)
                                    val end = maxOf(selectionStart, selectionEnd).coerceAtMost(text.length)
                                    if (end > begin && end - begin <= 8000) followup(text.subSequence(begin, end).toString())
                                    else feedback = mobileText(R.string.quote_limit)
                                    return true
                                }
                                override fun onDestroyActionMode(mode: android.view.ActionMode) {}
                            }
                        }
                        content.addView(ScrollView(this).apply { addView(text) })
                    } else {
                        val imageView = ZoomImageView(this).apply {
                            id = IMAGE_ID
                            contentDescription = if (kind == PreviewKind.PDF) mobileText(R.string.preview_page_description, name, page + 1) else name
                            display(rendered.bitmap)
                            if (kind == PreviewKind.IMAGE) setOnClickListener { chromeVisible = !chromeVisible }
                        }
                        content.addView(imageView, FrameLayout.LayoutParams(-1, -1))
                    }
                    notice = if (rendered.truncated) mobileText(R.string.preview_truncated, PreviewPolicy.MAX_TEXT_CHARS) else null
                    empty = rendered.text?.isEmpty() == true
                    loading = false
                }
            } catch (error: Exception) { runOnUiThread {
                if (active && request == generation) {
                    this.error = when ((error as? PreviewFailure)?.reason) {
                        "protected" -> mobileText(R.string.protected_file)
                        "timeout" -> mobileText(R.string.preview_timeout)
                        else -> mobileText(R.string.preview_failed)
                    }
                    loading = false
                }
            } }
        }
    }
    @Deprecated("Android activity result compatibility")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != SAVE_REQUEST) return
        val uri = data?.data
        if (resultCode != RESULT_OK || uri == null) return
        io.execute {
            val saved = runCatching { DocumentExport(this).save(file, uri) }.isSuccess
            runOnUiThread { if (!isDestroyed) feedback = if (saved) mobileText(R.string.file_saved) else mobileText(R.string.error_document_save_failed) }
        }
    }
    private fun save() {
        try { startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).setType(mime).addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE, name), SAVE_REQUEST) }
        catch (_: android.content.ActivityNotFoundException) { feedback = mobileText(R.string.mobile_no_file_saver_available_the_phone_copy_is_retained) }
        catch (_: SecurityException) { feedback = mobileText(R.string.mobile_could_not_open_the_save_location_the_phone_copy) }
    }
    private fun share() {
        try {
            val uri = FileProvider.getUriForFile(this, "$packageName.files", file, name)
            val intent = Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            intent.clipData = ClipData.newRawUri(name, uri)
            startActivity(Intent.createChooser(intent, mobileText(R.string.share_file_title)))
        } catch (_: android.content.ActivityNotFoundException) { feedback = mobileText(R.string.no_share_app) }
        catch (_: SecurityException) { feedback = mobileText(R.string.mobile_could_not_grant_another_app_read_access_the_phone) }
    }
    private fun openWith() {
        try {
            val uri = FileProvider.getUriForFile(this, "$packageName.files", file, name)
            val open = Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            open.clipData = ClipData.newRawUri(name, uri)
            startActivity(Intent.createChooser(open, mobileText(R.string.open_other_app)))
        } catch (_: android.content.ActivityNotFoundException) { feedback = mobileText(R.string.preview_no_viewer) }
        catch (_: SecurityException) { feedback = mobileText(R.string.mobile_could_not_grant_another_app_read_access_the_phone) }
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
        image?.recycle(); image = null
        super.onStop()
    }
    override fun onDestroy() { io.shutdownNow(); super.onDestroy() }
    private fun dp(value: Int) = (resources.displayMetrics.density * value).toInt()
    companion object { const val QUOTE_ID = 0x2207; const val TEXT_ID = 0x2202; const val IMAGE_ID = 0x2209; private const val SAVE_REQUEST = 4101 }
}
