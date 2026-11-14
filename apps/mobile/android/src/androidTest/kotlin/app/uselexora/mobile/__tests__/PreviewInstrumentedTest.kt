package app.uselexora.mobile

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.pdf.PdfDocument
import android.media.ExifInterface
import android.os.Process
import android.os.SystemClock
import android.widget.Button
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.preview.*
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class PreviewInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun file(suffix: String) = File(File(context.filesDir, "exports").apply { mkdirs() }, "preview-${UUID.randomUUID()}.$suffix")
    private fun pdf(file: File) {
        val document = PdfDocument()
        try {
            for (index in 0..1) {
                val page = document.startPage(PdfDocument.PageInfo.Builder(240, 320, index + 1).create())
                page.canvas.drawColor(if (index == 0) Color.RED else Color.BLUE)
                document.finishPage(page)
            }
            file.outputStream().use { document.writeTo(it) }
        } finally { document.close() }
    }
    @Test fun isolatedRendererProducesBoundedPixelsAndKeepsOriginalFiles() {
        val source = file("pdf")
        val image = file("png")
        pdf(source)
        val original = source.readBytes()
        val bitmap = Bitmap.createBitmap(2400, 1600, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(Color.GREEN)
        image.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        try { PreviewClient(context).use { renderer ->
            val first = renderer.render(source, PreviewKind.PDF)
            assertNotEquals(Process.myUid(), first.rendererUid)
            assertEquals(2, first.pageCount)
            assertEquals(Color.RED, first.bitmap!!.getPixel(100, 100)); first.bitmap.recycle()
            val second = renderer.render(source, PreviewKind.PDF, 1)
            assertEquals(Color.BLUE, second.bitmap!!.getPixel(100, 100)); second.bitmap.recycle()
            val photo = renderer.render(image, PreviewKind.IMAGE)
            assertTrue(photo.bitmap!!.width.toLong() * photo.bitmap.height <= PreviewPolicy.MAX_PIXELS)
            assertEquals(Color.GREEN, photo.bitmap.getPixel(10, 10)); photo.bitmap.recycle()
            val camera = Bitmap.createBitmap(240, 120, Bitmap.Config.ARGB_8888)
            camera.eraseColor(Color.RED)
            image.outputStream().use { camera.compress(Bitmap.CompressFormat.JPEG, 95, it) }; camera.recycle()
            ExifInterface(image.absolutePath).apply { setAttribute(ExifInterface.TAG_ORIENTATION, "6"); saveAttributes() }
            val rotated = renderer.render(image, PreviewKind.IMAGE)
            assertEquals(120, rotated.bitmap!!.width); assertEquals(240, rotated.bitmap.height)
            rotated.bitmap.recycle()
            assertArrayEquals(original, source.readBytes())
            source.writeText("%PDF-invalid")
            assertTrue(runCatching { renderer.render(source, PreviewKind.PDF) }.isFailure)
        } } finally { source.delete(); image.delete() }
    }
    @Test fun textPreviewPreservesLiteralContentAndTruncatesWithoutBreakingEmoji() {
        val source = file("txt")
        try { PreviewClient(context).use { renderer ->
            source.writeText("<script>literal only</script>\n中文 😀")
            val text = renderer.render(source, PreviewKind.TEXT)
            assertEquals(source.readText(), text.text); assertFalse(text.truncated)
            source.writeText("中😀".repeat(30000))
            val truncated = renderer.render(source, PreviewKind.TEXT)
            assertTrue(truncated.truncated)
            assertTrue(truncated.text!!.length <= PreviewPolicy.MAX_TEXT_CHARS)
            assertFalse(Character.isHighSurrogate(truncated.text.last()))
            source.writeBytes(byteArrayOf(0xC3.toByte(), 0x28))
            assertTrue(runCatching { renderer.render(source, PreviewKind.TEXT) }.isFailure)
        } } finally { source.delete() }
    }
    @Test fun pdfPageAndTextContentSurviveActivityRecreation() {
        val source = file("pdf")
        pdf(source)
        try {
            val intent = Intent(context, PreviewActivity::class.java).putExtra("path", source.absolutePath).putExtra("name", "报告.pdf").putExtra("mime", "application/pdf")
            ActivityScenario.launch<PreviewActivity>(intent).use { scenario ->
                fun label(): String { var value = ""; scenario.onActivity { value = it.findViewById<TextView>(PreviewActivity.PAGE_ID).text.toString() }; return value }
                waitFor { label() == "1 / 2" }
                scenario.onActivity { it.findViewById<Button>(PreviewActivity.NEXT_ID).performClick() }
                waitFor { label() == "2 / 2" }
                capture("pdf-preview.png")
                scenario.recreate()
                waitFor { label() == "2 / 2" }
                scenario.onActivity { it.findViewById<Button>(PreviewActivity.PREVIOUS_ID).performClick() }
                waitFor { label() == "1 / 2" }
            }
            source.writeText("<script>不会执行</script>\n中文 😀")
            intent.putExtra("name", "notes.txt").putExtra("mime", "text/plain")
            ActivityScenario.launch<PreviewActivity>(intent).use { scenario ->
                waitFor { var text: String? = null; scenario.onActivity { text = it.findViewById<TextView>(PreviewActivity.TEXT_ID)?.text?.toString() }; text == source.readText() }
                capture("text-preview.png")
                scenario.recreate()
                waitFor { var text: String? = null; scenario.onActivity { text = it.findViewById<TextView>(PreviewActivity.TEXT_ID)?.text?.toString() }; text == source.readText() }
            }
        } finally { source.delete() }
    }
    @Test fun markdownActivityDisplaysContentAndReturnsAnExplicitFollowup() {
        val source = file("md")
        source.writeText("# Markdown 验收\n\n这是预览文件的正文。")
        try {
            val intent = Intent(context, PreviewActivity::class.java).putExtra("path", source.absolutePath).putExtra("name", "报告.md").putExtra("mime", "text/markdown").putExtra("canFollowup", true)
            ActivityScenario.launchActivityForResult<PreviewActivity>(intent).use { scenario ->
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.contains("Markdown 验收") }
                capture("markdown-preview.png")
                scenario.onActivity { it.findViewById<Button>(PreviewActivity.FOLLOWUP_ID).performClick() }
                assertEquals(android.app.Activity.RESULT_OK, scenario.result.resultCode)
                assertEquals("", scenario.result.resultData.getStringExtra("quote"))
                assertEquals("# Markdown 验收\n\n这是预览文件的正文。", source.readText())
            }
        } finally { source.delete() }
    }
    private fun capture(name: String) {
        if (InstrumentationRegistry.getArguments().getString("captureScreenshots") != "true") return
        InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot()?.let { bitmap ->
            File(context.externalCacheDir, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }
    private fun waitFor(condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 10000
        while (SystemClock.uptimeMillis() < deadline) { if (condition()) return; SystemClock.sleep(30) }
        assertTrue("Preview did not reach the expected page or content", condition())
    }
}
