package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.lifecycle.Lifecycle
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.protocol.CommandOutbox
import app.uselexora.mobile.protocol.DraftContext
import app.uselexora.mobile.protocol.MobileInputCommands
import app.uselexora.mobile.protocol.ProductProjection
import app.uselexora.mobile.protocol.ProductSubscription
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.ui.MainActivity
import app.uselexora.mobile.MobileUiTestDriver.click
import app.uselexora.mobile.MobileUiTestDriver.contains as text
import app.uselexora.mobile.MobileUiTestDriver.waitUntil as waitFor
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class InterruptionInstrumentedTest {
    @Test fun restartReconcilesTheOriginalRunAndOnlyAnExplicitNewIntentStartsItsSuccessor() {
        val token = InstrumentationRegistry.getArguments().getString("interruptionToken")
        assumeTrue(token?.matches(Regex("[a-f0-9-]{36}")) == true)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val config = JSONObject(ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand("cat /data/local/tmp/lexora-interruption-$token.json")).bufferedReader().use { it.readText() })
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val connection = MobileConnection(context, schemas, BuildConfig.VERSION_NAME)
        connection.pair(config.getJSONObject("pairing").toString())
        var client = connection.connect()!!
        val partition = client.identity!!.partition
        val instance = client.identity!!.serviceInstanceId
        fun marker(stage: String) = File(context.filesDir, "interruption-$token-$stage.json")
        fun signal(stage: String, value: JSONObject) { marker(stage).writeText(value.toString()) }
        fun awaitSignal(stage: String) = waitFor(60000) { marker(stage).isFile }
        try { LocalStore(context).use { store ->
            store.edit(partition, "global", JSONObject().put("content", MobileContentAdapter.textContent("不相关的手机输入保留😀")))
            val scope = "draft:${store.newId()}"
            val input = store.edit(partition, scope, JSONObject().put("content", MobileContentAdapter.textContent("服务中断后等待我明确重新生成\n" + (1..40).joinToString("\n") { "保留正在阅读的输入第 $it 行" })))
            val original = MobileInputCommands(store).send(client, input, DraftContext.target(scope))
            assertTrue(store.outbox(partition).none { it.id == original.getString("commandId") })
            val originalTarget = original.getJSONObject("target")
            val runId = originalTarget.getString("runId")
            val conversationId = originalTarget.getString("conversationId")
            val task = client.call("conversations.get", JSONObject().put("conversationId", conversationId))
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
                MobileUiTestDriver.awaitConnected()
                MobileUiTestDriver.openTask(task.getString("title"))
                val reader = TimelineViewport()
                waitFor { reader.visibleText("中断前的部分回复") }
                reader.scrollToStart()
                val anchorText = "服务中断后等待我明确重新生成"
                waitFor { reader.visibleText(anchorText) && reader.latestVisible() }
                val readingTop = reader.userMessageTop()
                assertFalse(reader.visibleText("中断前的部分回复"))
                val live = ProductProjection()
                val observer = ProductSubscription(client, schemas, live::snapshot, live::apply) { }
                try {
                    observer.subscribe("conversation:${android.net.Uri.encode(conversationId)}:${android.net.Uri.encode(originalTarget.getString("branchId"))}")
                    signal("stream-visible", originalTarget)
                    waitFor {
                        live.items().any { it.optString("entity") == "message" && it.getJSONObject("value").getJSONObject("body").optString("text") == "中断前的部分回复接着输出" }
                    }
                    val observeUntil = SystemClock.uptimeMillis() + 1000
                    while (SystemClock.uptimeMillis() < observeUntil) {
                        assertEquals(readingTop, reader.userMessageTop(), 1.0)
                        assertTrue(reader.latestVisible())
                        assertFalse(reader.visibleText("中断前的部分回复接着输出"))
                        SystemClock.sleep(50)
                    }
                    reader.openLatest()
                    waitFor { reader.visibleText("中断前的部分回复接着输出") }
                } finally { observer.close() }
                scenario.recreate()
                waitFor { reader.visibleText("中断前的部分回复接着输出") }
                capture("interruption-$token-live.png")
                scenario.moveToState(Lifecycle.State.CREATED)
                signal("started", originalTarget)
                awaitSignal("restarted")
                client.close()
                client = connection.connect()!!
                assertEquals(partition, client.identity!!.partition)
                assertNotEquals(instance, client.identity!!.serviceInstanceId)
                val checked = client.call("commands.get", JSONObject().put("dataGeneration", client.identity!!.dataGeneration).put("commandId", original.getString("commandId")))
                assertEquals("decided", checked.getString("lookup"))
                assertEquals(original.toString(), checked.getJSONObject("receipt").toString())
                val ended = client.call("runs.get", JSONObject().put("runId", runId))
                assertTrue(ended.getString("status") in setOf("failed", "cancelled"))
                assertEquals("released", client.call("runs.getExecutionState", JSONObject().put("runId", runId)).getString("resources"))
                val before = store.outbox(partition).size
                scenario.moveToState(Lifecycle.State.RESUMED)
                waitFor { reader.visibleText("中断前的部分回复接着输出") }
                assertEquals(before, store.outbox(partition).size)
                signal("reconciled", JSONObject().put("oldTarget", originalTarget).put("oldStatus", ended.getString("status")).put("originalReceiptRecovered", true))
                awaitSignal("allow-new-intent")
                reader.openReplyMenu("中断前的部分回复接着输出")
                click("重新生成这条回复")
                waitFor { reader.visibleText("中断后新回复") }
                val successor = store.outbox(partition).single { it.method == "chat.regenerateAssistant" }
                val target = successor.receipt!!.getJSONObject("target")
                assertNotEquals(original.getString("commandId"), successor.id)
                assertNotEquals(runId, target.getString("runId"))
                assertEquals(conversationId, target.getString("conversationId"))
                assertNotEquals(originalTarget.getString("branchId"), target.getString("branchId"))
                assertEquals(runId, successor.envelope.getJSONObject("intent").getString("sourceRunId"))
                assertEquals(original.toString(), client.call("commands.get", JSONObject().put("dataGeneration", client.identity!!.dataGeneration).put("commandId", original.getString("commandId"))).getJSONObject("receipt").toString())
                assertEquals(successor.receipt.toString(), CommandOutbox(store).retry(client, successor).toString())
                assertEquals(ended.getString("status"), client.call("runs.get", JSONObject().put("runId", runId)).getString("status"))
                assertEquals("不相关的手机输入保留😀", MobileContentAdapter.text(store.draft(partition, "global")!!.value.getJSONObject("content")))
                capture("interruption-$token-completed.png")
                signal("done", JSONObject().put("original", originalTarget).put("successor", target).put("oldStatus", ended.getString("status")).put("fixedOriginalReceipt", true).put("explicitNewCommand", true).put("localInputPreserved", true))
            }
        } } finally { client.close(); connection.forget(connection.description()) }
    }
    private class TimelineViewport {
        private val handler = Handler(Looper.getMainLooper())

        private fun findWebView(view: View): WebView? = when (view) {
            is WebView -> view
            is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { findWebView(view.getChildAt(it)) }
            else -> null
        }

        private fun eval(script: String): String {
            val result = CompletableFuture<String>()
            handler.post {
                val activity = ActivityLifecycleMonitorRegistry.getInstance()
                    .getActivitiesInStage(Stage.RESUMED).filterIsInstance<MainActivity>().firstOrNull()
                val web = activity?.window?.decorView?.let(::findWebView)
                if (web == null) result.complete("null") else web.evaluateJavascript(script) { result.complete(it ?: "null") }
            }
            return result.get(4, TimeUnit.SECONDS)
        }

        fun scrollToStart() = eval("document.querySelector('.reader-viewport').scrollTop=0")
        fun userMessageTop() = eval("document.querySelector('.reader-message.user')?.getBoundingClientRect().top").toDouble()
        fun openLatest() = eval("document.querySelector('.latest-button').click()")
        fun openReplyMenu(text: String) {
            assertEquals("true", eval("""
                (() => {
                    const reply = [...document.querySelectorAll('.reader-message.assistant')]
                        .find(row => row.innerText.includes(${JSONObject.quote(text)}));
                    const button = reply?.querySelector('[aria-label="更多消息操作"]');
                    if (!button) return false;
                    button.click(); return true;
                })()
            """.trimIndent()))
        }

        fun latestVisible() = eval("!!document.querySelector('.latest-button')?.offsetHeight") == "true"
        fun visibleText(text: String) = eval("""(() => {
            const v=document.querySelector('.reader-viewport'); if (!v) return false;
            const q=${JSONObject.quote(text)}, walk=document.createTreeWalker(v,NodeFilter.SHOW_TEXT), viewport=v.getBoundingClientRect(); let n;
            while ((n=walk.nextNode())) { const i=n.data.indexOf(q); if(i<0) continue;
                const range=document.createRange(); range.setStart(n,i); range.setEnd(n,i+q.length);
                if ([...range.getClientRects()].some(r => r.width>0 && r.height>0 && r.top<viewport.bottom && r.bottom>viewport.top)) return true;
            } return false;
        })()""") == "true"
    }
    private fun capture(name: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.waitForIdle(700, 5000)
        instrumentation.uiAutomation.takeScreenshot()?.let { bitmap -> File(instrumentation.targetContext.filesDir, name).outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
    }
}
