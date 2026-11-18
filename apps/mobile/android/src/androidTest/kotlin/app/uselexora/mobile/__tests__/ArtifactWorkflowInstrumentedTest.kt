package app.uselexora.mobile

import android.content.Intent
import android.os.ParcelFileDescriptor
import android.view.View
import android.view.Choreographer
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.ui.MainActivity
import app.uselexora.mobile.ui.MobileAppearance
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class ArtifactWorkflowInstrumentedTest {
    @Test fun publishedFilesLoadThumbnailsAndOpenVerifiedPreview() {
        val token = InstrumentationRegistry.getArguments().getString("artifactWorkflowToken")
        assumeTrue(token?.matches(Regex("[a-f0-9-]{36}")) == true)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val config = JSONObject(ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand("cat /data/local/tmp/lexora-artifacts-$token.json")).bufferedReader().use { it.readText() })
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val connection = MobileConnection(context, schemas, BuildConfig.VERSION_NAME)
        connection.pair(config.getJSONObject("pairing").toString())
        val client = connection.connect()!!
        try {
            assertTrue(client.supports("runs.listOutputs"))
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
                fun browser(view: View): WebView? = if (view is WebView) view else (view as? ViewGroup)?.let { group -> (0 until group.childCount).firstNotNullOfOrNull { browser(group.getChildAt(it)) } }
                fun js(script: String): String {
                    val latch = CountDownLatch(1)
                    val result = AtomicReference("null")
                    scenario.onActivity { activity ->
                        val web = browser(activity.window.decorView)
                        if (web == null) latch.countDown() else web.evaluateJavascript(script) { result.set(it); latch.countDown() }
                    }
                    assertTrue(latch.await(5, TimeUnit.SECONDS))
                    return result.get()
                }
                fun screenshot(name: String) {
                    val painted = CountDownLatch(1)
                    scenario.onActivity { activity ->
                        browser(activity.window.decorView)?.takeIf { activity.hasWindowFocus() }?.postVisualStateCallback(0, object : WebView.VisualStateCallback() {
                            override fun onComplete(requestId: Long) { painted.countDown() }
                        }) ?: painted.countDown()
                    }
                    assertTrue(painted.await(5, TimeUnit.SECONDS))
                    val frames = CountDownLatch(2)
                    instrumentation.runOnMainSync {
                        Choreographer.getInstance().postFrameCallback(object : Choreographer.FrameCallback {
                            override fun doFrame(time: Long) {
                                frames.countDown()
                                if (frames.count > 0) Choreographer.getInstance().postFrameCallback(this)
                            }
                        })
                    }
                    assertTrue(frames.await(5, TimeUnit.SECONDS))
                    val bitmap = instrumentation.uiAutomation.takeScreenshot()!!
                    try { File(context.filesDir, "artifacts-$token-$name.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) } }
                    finally { bitmap.recycle() }
                }
                MobileUiTestDriver.awaitConnected()
                MobileUiTestDriver.openTask(config.getString("taskTitle"))
                MobileUiTestDriver.waitUntil { js("document.querySelectorAll('.artifact-card').length === 2") == "true" }
                MobileUiTestDriver.waitUntil { js("Array.from(document.querySelectorAll('.artifact-preview img')).some(i=>i.complete&&i.naturalWidth>0&&i.naturalWidth<=320)") == "true" }
                assertEquals("true", js("document.querySelectorAll('[data-output-run-id]').length === 1"))
                assertEquals("true", js("Array.from(document.querySelectorAll('.artifact-preview img')).every(i=>i.getBoundingClientRect().bottom<=i.parentElement.getBoundingClientRect().bottom+1)"))
                assertEquals("true", js("document.querySelector('[data-output-run-id] .artifact-heading')?.textContent.includes('产物')"))
                assertEquals("true", js("Array.from(document.querySelectorAll('.artifact-card')).every(x=>x.getBoundingClientRect().height<=76&&x.getBoundingClientRect().width<=224)"))
                assertEquals("true", js("(()=>{const s=document.querySelector('.artifact-strip');s.scrollLeft=100;return s.scrollWidth>s.clientWidth&&s.scrollLeft>0})()"))
                js("document.querySelector('.artifact-heading').click()")
                assertEquals("true", js("document.querySelector('.artifact-heading').getAttribute('aria-expanded')==='false'&&document.querySelector('.artifact-strip').getBoundingClientRect().height===0"))
                js("document.querySelector('.artifact-heading').click();document.querySelector('.artifact-strip').scrollLeft=0")
                MobileUiTestDriver.waitUntil { js("document.querySelector('.artifact-strip').getBoundingClientRect().height>0") == "true" }
                screenshot("cards")
                js("Array.from(document.querySelectorAll('.artifact-card')).find(x=>x.innerText.includes('preview.png')).querySelector('.artifact-open').click()")
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.existsTag("preview-ready") }
                screenshot("preview")
                instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
                MobileUiTestDriver.waitUntil { js("document.querySelectorAll('.artifact-card').length === 2") == "true" }
                MobileUiTestDriver.openTaskSettings()
                MobileUiTestDriver.awaitConnected()
                MobileUiTestDriver.returnToConversation()
                js("Array.from(document.querySelectorAll('.artifact-card')).find(x=>x.innerText.includes('notes.txt')).querySelector('.artifact-open').click()")
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.exists("Mobile artifact preview verified.") }
                instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
                MobileUiTestDriver.waitUntil { js("document.querySelectorAll('.artifact-card').length === 2") == "true" }
                js("Array.from(document.querySelectorAll('.artifact-card')).find(x=>x.innerText.includes('notes.txt')).querySelector('.artifact-more').click()")
                MobileUiTestDriver.waitUntil { MobileUiTestDriver.exists("保存到文件") && MobileUiTestDriver.exists("分享文件") }
                screenshot("actions")
                MobileUiTestDriver.click("关闭")
                scenario.onActivity { MobileAppearance.selectTheme(context, "dark") }
                MobileUiTestDriver.waitUntil { js("document.querySelector('main')?.classList.contains('dark')") == "true" }
                screenshot("cards-dark")
                scenario.onActivity { MobileAppearance.selectTheme(context, "system") }
                js("document.querySelectorAll('.buddy-chat-activity-group__header[aria-expanded=false]').forEach(x=>x.click())")
                MobileUiTestDriver.waitUntil { js("document.querySelector('.buddy-chat-tool__header') !== null") == "true" }
                js("document.querySelector('.buddy-chat-tool__header').click()")
                MobileUiTestDriver.waitUntil { js("document.querySelectorAll('.tool-image-preview img').length === 2 && Array.from(document.querySelectorAll('.tool-image-preview img')).every(x=>x.complete&&x.naturalWidth>0)") == "true" }
                MobileUiTestDriver.waitUntil { js("document.querySelector('.tool-image-retry') !== null") == "true" }
                assertEquals("true", js("!document.body.innerText.includes('lexora-artifact://') && !document.body.innerText.includes('附件地址')"))
                assertEquals("true", js("Array.from(document.querySelectorAll('.buddy-chat-activity-row')).every(x=>x.getBoundingClientRect().height>=28&&x.getBoundingClientRect().height<=32)"))
                assertEquals("true", js("Array.from(document.querySelectorAll('.tool-image-preview img')).every(x=>x.src.startsWith('https://appassets.androidplatform.net/artifacts/')&&x.naturalWidth<=320)"))
                js("document.querySelector('.buddy-chat-tool-details').scrollIntoView({block:'start'})")
                screenshot("tool-images")
                for (kind in listOf("reference", "artifact")) {
                    MobileUiTestDriver.waitUntil {
                        var focused = false
                        scenario.onActivity { focused = it.hasWindowFocus() }
                        focused
                    }
                    js("document.querySelector('[data-image-kind=$kind]').scrollIntoView({block:'center'})")
                    MobileUiTestDriver.waitUntil { js("document.querySelector('[data-image-kind=$kind] .tool-image-preview:not(:disabled)') !== null") == "true" }
                    assertEquals("\"clicked-$kind\"", js("(()=>{try{document.querySelector('[data-image-kind=$kind] .tool-image-preview:not(:disabled)').click();return 'clicked-$kind'}catch(e){return String(e)}})()"))
                    try { MobileUiTestDriver.waitUntil { MobileUiTestDriver.existsTag("preview-ready") } }
                    catch (failure: AssertionError) { throw AssertionError("Tool image preview failed: $kind", failure) }
                    instrumentation.uiAutomation.performGlobalAction(android.accessibilityservice.AccessibilityService.GLOBAL_ACTION_BACK)
                    MobileUiTestDriver.waitUntil { js("document.querySelector('.tool-image-preview') !== null") == "true" }
                }
                js("document.querySelector('[data-image-kind=reference]').scrollIntoView({block:'center'})")
                MobileUiTestDriver.waitUntil { js("document.querySelector('.tool-image-retry') !== null") == "true" }
                js("document.querySelector('.tool-image-retry').click()")
                MobileUiTestDriver.waitUntil { js("document.querySelector('.tool-image-retry') !== null") == "true" }
                scenario.onActivity { MobileAppearance.selectTheme(context, "dark") }
                MobileUiTestDriver.waitUntil { js("document.querySelector('main')?.classList.contains('dark')") == "true" }
                js("document.querySelector('.buddy-chat-tool-details').scrollIntoView({block:'start'})")
                MobileUiTestDriver.waitUntil { js("document.querySelectorAll('.tool-image-preview img').length === 2 && Array.from(document.querySelectorAll('.tool-image-preview img')).every(x=>x.complete&&x.naturalWidth>0)") == "true" }
                assertEquals("true", js("document.querySelectorAll('.tool-image-retry').length === 1"))
                screenshot("tool-images-dark")
                scenario.onActivity { MobileAppearance.selectTheme(context, "system") }
            }
        } finally {
            client.close()
            connection.description()?.let { connection.logout(it) }
        }
    }
}
