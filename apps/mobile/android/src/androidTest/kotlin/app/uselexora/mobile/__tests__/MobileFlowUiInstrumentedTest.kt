package app.uselexora.mobile

import androidx.compose.foundation.layout.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.viewinterop.AndroidView
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.preview.PreviewDocumentView
import app.uselexora.mobile.ui.*
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class MobileFlowUiInstrumentedTest {
    @get:Rule val compose = createComposeRule()
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private var host: PreviewDocumentView? = null
    private var originalLanguage = "zh"
    @Before fun language() { compose.runOnUiThread { originalLanguage = MobileAppearance.language; MobileAppearance.selectLanguage(context, "en") } }
    @After fun release() { compose.runOnUiThread { host?.release(); MobileAppearance.selectLanguage(context, originalLanguage) } }
    private fun js(script: String): String {
        val result = AtomicReference<String>()
        val latch = CountDownLatch(1)
        compose.runOnUiThread { host!!.evaluateJavascript(script) { result.set(it); latch.countDown() } }
        check(latch.await(5, TimeUnit.SECONDS))
        return result.get()
    }
    private fun until(script: String) {
        val deadline = System.currentTimeMillis() + 20_000
        while (System.currentTimeMillis() < deadline) { if (js(script) == "true") return; Thread.sleep(100) }
        fail("Document condition failed: $script; page=${js("document.body.innerText")}")
    }
    @Test fun markdownUsesPackagedRendererAndReturnsSelectedTextWithoutLoadingExternalContent() {
        val quote = AtomicReference<String>()
        val text = "# Mobile report\n\n| Item | Status |\n| --- | --- |\n| Share draft | Ready |\n\n```kotlin\nval count = 3\n```\n\nSelected paragraph 中文😀\n\n![external](https://example.invalid/no-request.png)\n\n<script>window.injected=true</script>"
        compose.setContent { AndroidView(factory = { context -> android.widget.FrameLayout(context).apply { addView(PreviewDocumentView(context, text, true, quote::set).also { view -> host = view }, android.widget.FrameLayout.LayoutParams(-1, -1)) } }, modifier = Modifier.fillMaxSize(), onRelease = { host?.release() }) }
        until("document.querySelector('h1')?.textContent === 'Mobile report' && document.querySelector('table') !== null")
        assertEquals(JSONObject.quote("en"), js("document.documentElement.lang"))
        assertEquals("false", js("window.injected === true"))
        assertEquals("0", js("document.querySelectorAll('.markstream-vue img').length"))
        assertEquals("false", js("performance.getEntriesByType('resource').some(x => x.name.includes('example.invalid'))"))
        assertEquals("true", js("document.documentElement.scrollWidth <= innerWidth"))
        until("(() => { const paragraph = Array.from(document.querySelectorAll('p')).find(x => x.textContent === 'Selected paragraph 中文😀'); if (!paragraph) return false; paragraph.scrollIntoView({block:'center'}); return paragraph.getBoundingClientRect().height > 0; })()")
        until("document.querySelector('.document-page').getBoundingClientRect().height >= innerHeight - 1")
        val selected = js("(() => { const walker = document.createTreeWalker(document.querySelector('.document-body'), NodeFilter.SHOW_TEXT); let node; while ((node = walker.nextNode())) { if (node.textContent === 'Selected paragraph 中文😀') { const range = document.createRange(); range.selectNodeContents(node); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); document.dispatchEvent(new Event('selectionchange')); return selection.toString(); } } return 'missing text node'; })()")
        assertEquals(JSONObject.quote("Selected paragraph 中文😀"), selected)
        until("document.querySelector('.quote-selection')?.textContent.includes('Continue') === true")
        js("document.querySelector('.quote-selection').click()")
        compose.waitUntil(5_000) { quote.get() != null }
        assertEquals("Selected paragraph 中文😀", quote.get())
    }
}
