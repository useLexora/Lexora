package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import android.content.Intent
import android.widget.EditText
import android.os.ParcelFileDescriptor
import androidx.core.content.FileProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.network.MobileFiles
import app.uselexora.mobile.protocol.CommandOutbox
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.TransferStore
import app.uselexora.mobile.ui.MainActivity
import app.uselexora.mobile.MobileUiTestDriver.click
import app.uselexora.mobile.MobileUiTestDriver.waitUntil as waitFor
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class DesktopWorkflowInstrumentedTest {
    @Test fun independentLocalInputsSubmitOnceWithAttachmentsAndPreserveLaterEdits() {
        val token = InstrumentationRegistry.getArguments().getString("desktopWorkflowToken")
        assumeTrue(token?.matches(Regex("[a-f0-9-]{36}")) == true)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val config = JSONObject(ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand("cat /data/local/tmp/lexora-desktop-$token.json")).bufferedReader().use { it.readText() })
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val connection = MobileConnection(context, schemas, BuildConfig.VERSION_NAME)
        connection.pair(config.getJSONObject("pairing").toString())
        val client = connection.connect()!!
        val marker = File(context.filesDir, "desktop-$token-ready.json")
        val resume = File(context.filesDir, "desktop-$token-resume.json")
        try { LocalStore(context).use { store -> TransferStore(context).use { transfers ->
            val owner = client.identity!!.partition
            val firstId = store.newId(); val scope = "draft:$firstId"
            val otherScope = "draft:${store.newId()}"
            val targetScope = JSONObject().put("kind", "task").put("draftId", firstId).put("spaceId", JSONObject.NULL)
            val firstText = "Android 本地输入与附件😀"
            store.edit(owner, scope, JSONObject().put("content", MobileContentAdapter.textContent(firstText)).put("executionConfig", JSONObject().put("executionProfile", "read_only").put("approvalPolicy", "policy")))
            store.edit(owner, otherScope, JSONObject().put("content", MobileContentAdapter.textContent("另一个任务的未发送输入")))
            val source = File(File(context.filesDir, "exports").apply { mkdirs() }, "$token.txt").apply { writeText("附件内容完整保留😀") }
            val files = MobileFiles(context, transfers, store, connection)
            val transfer = try { files.stage(FileProvider.getUriForFile(context, "${context.packageName}.files", source), owner, scope, targetScope) } finally { source.delete() }
            assertEquals("accepted", files.upload(client, transfer, JSONObject().put("inputId", store.inputId(owner, scope))).getString("decision"))
            assertEquals(1, store.draft(owner, scope)!!.value.getJSONObject("content").getJSONArray("panelResourceIds").length())
            marker.writeText(JSONObject().put("inputId", store.inputId(owner, scope)).put("ownerDeviceId", client.identity!!.deviceId).put("attachmentCount", 1).toString())
            waitFor(60000) { resume.isFile }
            val expected = JSONObject(resume.readText()).getString("text")
            val expired = transfers.list(owner).single { it.getString("id") == transfer.getString("id") }
            assertEquals("accepted", files.upload(client, expired, JSONObject().put("inputId", store.inputId(owner, scope))).getString("decision"))
            val replaced = transfers.list(owner).single { it.getString("id") == transfer.getString("id") }
            assertNotEquals(expired.getString("uploadId"), replaced.getString("uploadId"))
            assertNotEquals(expired.getString("resourceId"), replaced.getString("resourceId"))
            assertEquals(1, store.draft(owner, scope)!!.value.getJSONObject("content").getJSONArray("panelResourceIds").length())
            assertEquals(firstText, MobileContentAdapter.text(store.draft(owner, scope)!!.value.getJSONObject("content")))
            assertEquals(2, store.outbox(owner).count { it.method == "uploads.stage" })
            assertEquals(expected, MobileContentAdapter.text(client.call("composerDrafts.get", JSONObject().put("draftId", config.getString("draftId"))).getJSONObject("content")))
            ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
                fun avatarVisible(): Boolean {
                    val latch = java.util.concurrent.CountDownLatch(1)
                    val result = java.util.concurrent.atomic.AtomicBoolean(false)
                    scenario.onActivity { activity ->
                        fun browser(view: android.view.View): android.webkit.WebView? = if (view is android.webkit.WebView) view else
                            (view as? android.view.ViewGroup)?.let { group -> (0 until group.childCount).firstNotNullOfOrNull { browser(group.getChildAt(it)) } }
                        val web = browser(activity.window.decorView)
                        if (web == null) latch.countDown() else web.evaluateJavascript("Array.from(document.querySelectorAll('.message-avatar img')).some(i=>i.src.includes('${config.getString("avatarHash")}')&&i.complete&&i.naturalWidth>0&&i.naturalWidth<=256)") { value -> result.set(value == "true"); latch.countDown() }
                    }
                    return latch.await(5, java.util.concurrent.TimeUnit.SECONDS) && result.get()
                }
                fun input(): String { var value = ""; scenario.onActivity { value = it.findViewById<EditText>(MainActivity.INPUT_ID)?.text?.toString().orEmpty() }; return value }
                MobileUiTestDriver.awaitConnected()
                MobileUiTestDriver.openDrafts(); click("草稿 · $firstText"); click("继续编辑")
                waitFor { input() == firstText }
                scenario.recreate()
                waitFor { input() == firstText }
                assertTrue(MobileUiTestDriver.exists("权限：本机只读"))
                click("发送")
                scenario.onActivity { it.findViewById<EditText>(MainActivity.INPUT_ID).setText("发送期间继续写的下一条😀") }
                waitFor(30000) { store.outbox(owner).any { it.method == "chat.submitInput" && it.state == "accepted" } }
                val command = store.outbox(owner).single { it.method == "chat.submitInput" }
                val receipt = command.receipt!!
                val target = receipt.getJSONObject("target")
                waitFor(30000) { client.call("runs.get", JSONObject().put("runId", target.getString("runId"))).getString("status") == "completed" }
                waitFor { input() == "发送期间继续写的下一条😀" }
                assertEquals("另一个任务的未发送输入", MobileContentAdapter.text(store.draft(owner, otherScope)!!.value.getJSONObject("content")))
                val current = store.draft(owner, "conversation:${target.getString("conversationId")}:${target.getString("branchId")}")!!
                assertEquals(0, current.value.getJSONObject("content").getJSONArray("panelResourceIds").length())
                assertEquals(receipt.toString(), CommandOutbox(store).retry(client, command).toString())
                val messages = client.call("conversations.listMessages", JSONObject().put("conversationId", target.getString("conversationId")).put("branchId", target.getString("branchId"))).getJSONArray("items")
                val users = (0 until messages.length()).map { messages.getJSONObject(it) }.filter { it.getString("role") == "user" }
                assertEquals(1, users.size)
                val resource = users.single().getJSONArray("resources").getJSONObject(0)
                assertEquals("附件内容完整保留😀", files.download(client, resource).readText())
                waitFor(30000) { avatarVisible() }
                scenario.recreate()
                waitFor { input() == "发送期间继续写的下一条😀" }
                if (config.optBoolean("networkRecovery")) {
                    MobileUiTestDriver.openTaskSettings()
                    MobileUiTestDriver.awaitConnected()
                    File(context.filesDir, "desktop-$token-network-ready.json").writeText("ready")
                    waitFor(30000) { MobileUiTestDriver.exists("未连接") }
                    MobileUiTestDriver.returnToConversation()
                    scenario.recreate()
                    waitFor { input() == "发送期间继续写的下一条😀" }
                    assertEquals(1, store.outbox(owner).count { it.method == "chat.submitInput" })
                    waitFor { MobileUiTestDriver.contains("手机保存的内容") && MobileUiTestDriver.contains(firstText) }
                    val readCache = app.uselexora.mobile.storage.ReadCache(File(context.cacheDir, "product-read-v1"))
                    assertTrue(readCache.read(owner, "models")?.isNotEmpty() == true)
                    assertNull(readCache.read("different-device", "models"))
                    assertFalse(MobileUiTestDriver.enabled("发送"))
                    waitFor { avatarVisible() }
                    File(context.filesDir, "desktop-$token-offline.json").writeText("ready")
                    MobileUiTestDriver.openTaskSettings()
                    MobileUiTestDriver.awaitConnected()
                    MobileUiTestDriver.returnToConversation()
                    assertFalse(MobileUiTestDriver.contains("暂时无法到达服务"))
                    val reconnected = connection.connect()!!
                    try {
                        assertEquals(receipt.toString(), CommandOutbox(store).retry(reconnected, command).toString())
                        assertEquals("completed", reconnected.call("runs.get", JSONObject().put("runId", target.getString("runId"))).getString("status"))
                        assertEquals("附件内容完整保留😀", files.download(reconnected, resource).readText())
                    } finally { reconnected.close() }
                    assertEquals("发送期间继续写的下一条😀", input())
                    assertEquals(1, store.outbox(owner).count { it.method == "chat.submitInput" })
                }
                instrumentation.uiAutomation.takeScreenshot()?.let { bitmap -> File(context.filesDir, "desktop-$token.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
            }
        } } } finally {
            client.close()
            connection.description()?.let { connection.logout(it) }
            marker.delete(); resume.delete()
        }
    }
}
