package app.uselexora.mobile

import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.Matrix
import android.view.Choreographer
import android.view.InputDevice
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.graphics.pdf.PdfDocument
import android.media.ExifInterface
import android.os.Process
import android.os.SystemClock
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.preview.*
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.ui.MobileAppearance
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

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
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.exists("1 / 2") }
                MobileUiTestDriver.clickTag("preview-next")
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.exists("2 / 2") }
                capture("pdf-preview.png")
                scenario.recreate()
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.exists("2 / 2") }
                MobileUiTestDriver.clickTag("preview-previous")
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.exists("1 / 2") }
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
                MobileUiTestDriver.clickTag("preview-followup")
                assertEquals(android.app.Activity.RESULT_OK, scenario.result.resultCode)
                assertEquals("", scenario.result.resultData.getStringExtra("quote"))
                assertEquals("# Markdown 验收\n\n这是预览文件的正文。", source.readText())
            }
        } finally { source.delete() }
    }
    @Test fun failedPreviewCanRetryLocallyAndEmptyTextIsNotAFailure() {
        val source = file("txt")
        source.writeBytes(byteArrayOf(0xC3.toByte(), 0x28))
        val intent = Intent(context, PreviewActivity::class.java).putExtra("path", source.absolutePath).putExtra("name", "notes.txt").putExtra("mime", "text/plain")
        try {
            ActivityScenario.launch<PreviewActivity>(intent).use { scenario ->
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.existsTag("preview-retry") }
                assertArrayEquals(byteArrayOf(0xC3.toByte(), 0x28), source.readBytes())
                assertFalse(MobileUiTestDriver.existsTag("preview-followup"))
                source.writeText("")
                MobileUiTestDriver.clickTag("preview-retry")
                waitFor {
                    var empty = false
                    scenario.onActivity {
                        empty = it.findViewById<TextView>(PreviewActivity.TEXT_ID)?.text?.isEmpty() == true
                    }
                    empty
                }
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.exists(mobileText(R.string.preview_empty_text)) && !MobileUiTestDriver.existsTag("preview-retry") }
                assertEquals(0L, source.length())
            }
        } finally { source.delete() }
    }
    @Test fun imageGesturesKeepControlsStableAndFileActionsUseTheCurrentFile() {
        val source = file("png")
        context.resources.openRawResource(R.mipmap.ic_lexora).use { input -> source.outputStream().use { input.copyTo(it) } }
        val original = source.readBytes()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        var theme = "system"
        var language = "zh"
        instrumentation.runOnMainSync {
            MobileAppearance.load(context)
            theme = MobileAppearance.theme; language = MobileAppearance.language
            MobileAppearance.selectTheme(context, "light"); MobileAppearance.selectLanguage(context, "zh")
        }
        val name = "小猫插画的完整文件名称，需要在有限宽度内显示并且保留完整扩展名.png"
        val intent = Intent(context, PreviewActivity::class.java).putExtra("path", source.absolutePath).putExtra("name", name).putExtra("mime", "image/png").putExtra("canFollowup", true)
        try {
            ActivityScenario.launchActivityForResult<PreviewActivity>(intent).use { scenario ->
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.existsTag("preview-ready") }
                val title = requireNotNull(MobileUiTestDriver.bounds(name))
                assertTrue(title.right <= requireNotNull(MobileUiTestDriver.bounds("更多选项")).left)
                assertTrue(title.left >= requireNotNull(MobileUiTestDriver.bounds("返回")).right)
                fun scale(): Float {
                    var value = 0f
                    scenario.onActivity {
                        val matrix = FloatArray(9)
                        it.findViewById<ZoomImageView>(PreviewActivity.IMAGE_ID).imageMatrix.getValues(matrix)
                        value = matrix[Matrix.MSCALE_X]
                    }
                    return value
                }
                waitFor { var focused = false; scenario.onActivity { focused = it.hasWindowFocus() }; focused }
                val originalScale = scale()
                var x = 0f; var y = 0f
                scenario.onActivity {
                    val image = it.findViewById<ZoomImageView>(PreviewActivity.IMAGE_ID)
                    val location = IntArray(2); image.getLocationOnScreen(location)
                    x = location[0] + image.width / 2f; y = location[1] + image.height / 2f
                    val bounds = android.graphics.RectF(0f, 0f, image.drawable.intrinsicWidth.toFloat(), image.drawable.intrinsicHeight.toFloat())
                    image.imageMatrix.mapRect(bounds)
                    assertEquals(image.width / 2f, bounds.centerX(), 1f)
                    assertEquals(image.height / 2f, bounds.centerY(), 1f)
                    assertTrue(bounds.left >= -1f && bounds.top >= -1f && bounds.right <= image.width + 1f && bounds.bottom <= image.height + 1f)
                }
                fun tap() {
                    val down = SystemClock.uptimeMillis()
                    for (action in listOf(MotionEvent.ACTION_DOWN, MotionEvent.ACTION_UP)) {
                        val event = MotionEvent.obtain(down, SystemClock.uptimeMillis(), action, x, y, 0).apply { setSource(InputDevice.SOURCE_TOUCHSCREEN) }
                        try { instrumentation.sendPointerSync(event) } finally { event.recycle() }
                        if (action == MotionEvent.ACTION_DOWN) SystemClock.sleep(20)
                    }
                }
                tap(); SystemClock.sleep(60); tap()
                waitFor { scale() > originalScale * 1.9f }
                SystemClock.sleep(ViewConfiguration.getDoubleTapTimeout() + 50L)
                assertTrue(MobileUiTestDriver.existsTag("preview-more"))
                tap()
                MobileUiTestDriver.waitUntil { !MobileUiTestDriver.existsTag("preview-more") }
                tap()
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.existsTag("preview-more") }
                scenario.onActivity {
                    val image = it.findViewById<ZoomImageView>(PreviewActivity.IMAGE_ID)
                    val action = image.createAccessibilityNodeInfo().actionList.first { it.label == mobileText(R.string.zoom_out) }
                    assertTrue(image.performAccessibilityAction(action.id, null))
                }
                assertEquals(originalScale * 1.5f, scale(), 0.01f)
                scenario.recreate()
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.existsTag("preview-ready") }
                capture("image-preview-light.png")
                MobileUiTestDriver.clickTag("preview-more")
                MobileUiTestDriver.waitUntil { listOf("保存", "分享", "用其他应用打开", "文件信息").all { MobileUiTestDriver.exists(it) } }
                capture("image-preview-menu.png")
                MobileUiTestDriver.click("文件信息")
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.exists("image/png") }
                assertTrue(MobileUiTestDriver.exists(name))
                MobileUiTestDriver.click("关闭")
                instrumentation.runOnMainSync { MobileAppearance.selectTheme(context, "dark"); MobileAppearance.selectLanguage(context, "en") }
                scenario.recreate()
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.existsTag("preview-ready") && MobileUiTestDriver.exists("Continue editing") }
                capture("image-preview-dark.png")
                MobileUiTestDriver.clickTag("preview-more")
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.exists("File info") }
                assertTrue(MobileUiTestDriver.exists("Open in another app"))
                instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
                MobileUiTestDriver.clickTag("preview-followup")
                assertEquals(android.app.Activity.RESULT_OK, scenario.result.resultCode)
                assertEquals("", scenario.result.resultData.getStringExtra("quote"))
                assertArrayEquals(original, source.readBytes())
            }
        } finally {
            source.delete()
            instrumentation.runOnMainSync { MobileAppearance.selectTheme(context, theme); MobileAppearance.selectLanguage(context, language) }
        }
    }
    private fun capture(name: String) {
        if (InstrumentationRegistry.getArguments().getString("captureScreenshots") != "true") return
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val frames = CountDownLatch(3)
        instrumentation.runOnMainSync {
            Choreographer.getInstance().postFrameCallback(object : Choreographer.FrameCallback {
                override fun doFrame(time: Long) {
                    frames.countDown()
                    if (frames.count > 0) Choreographer.getInstance().postFrameCallback(this)
                }
            })
        }
        assertTrue(frames.await(5, TimeUnit.SECONDS))
        instrumentation.uiAutomation.takeScreenshot()?.let { bitmap ->
            File(context.filesDir, name).outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle()
        }
    }
    private fun waitFor(condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 10000
        while (SystemClock.uptimeMillis() < deadline) { if (condition()) return; SystemClock.sleep(30) }
        assertTrue("Preview did not reach the expected page or content", condition())
    }
}
