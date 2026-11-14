package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import android.view.Choreographer
import android.graphics.Rect
import android.util.AtomicFile
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.protocol.ProductIdentity
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.SecretStore
import app.uselexora.mobile.ui.MainActivity
import app.uselexora.mobile.MobileUiTestDriver.click
import app.uselexora.mobile.MobileUiTestDriver.waitUntil
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class DeviceSwitchInstrumentedTest {
    @Test fun twoRealComputersKeepCredentialsScopesAndLocalInputsIsolated() {
        val token = InstrumentationRegistry.getArguments().getString("deviceSwitchToken")
        assumeTrue(token?.matches(Regex("[a-f0-9-]{36}")) == true)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val backup = IdentityBackup(context, token!!)
        if (InstrumentationRegistry.getArguments().getString("deviceSwitchRestoreOnly") == "true") {
            backup.restore()
            return
        }
        val config = JSONObject(ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand("cat /data/local/tmp/lexora-devices-$token.json")).bufferedReader().use { it.readText() })
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val secrets = SecretStore(context)
        val connection = MobileConnection(context, schemas, BuildConfig.VERSION_NAME, secrets)
        val clients = mutableListOf<ProductClient>()
        val partitions = mutableSetOf<String>()
        val scope = "draft:$token"
        val marker = File(context.filesDir, "devices-$token.json")
        marker.delete()
        backup.capture()
        try { LocalStore(context).use { store ->
            try {
                secrets.clear()
                val first = config.getJSONObject("first")
                val second = config.getJSONObject("second")
                val identityA = connection.pair(first.getJSONObject("pairing").toString())
                val clientA = connection.connect()!!.also { clients.add(it) }
                val idA = connection.activeDeviceId()!!
                partitions.add(identityA.partition)
                backup.addPartition(identityA.partition)
                assertEquals(identityA.partition, clientA.identity!!.partition)
                assertScope(clientA, first, second)
                connection.renameDevice(idA, "验收服务 A")
                store.edit(identityA.partition, scope, JSONObject().put("content", MobileContentAdapter.textContent("服务 A 的本地输入😀")))

                val identityB = connection.pair(second.getJSONObject("pairing").toString())
                assertFalse(clientA.isConnected)
                val clientB = connection.connect()!!.also { clients.add(it) }
                val idB = connection.activeDeviceId()!!
                partitions.add(identityB.partition)
                backup.addPartition(identityB.partition)
                assertNotEquals(identityA.serviceId, identityB.serviceId)
                assertNotEquals(identityA.profileId, identityB.profileId)
                assertNotEquals(identityA.partition, identityB.partition)
                assertNotEquals(idA, idB)
                assertEquals(2, connection.savedDevices().size)
                assertEquals(idB, connection.savedDevices().single { it.selected }.id)
                assertScope(clientB, second, first)
                connection.renameDevice(idB, "验收服务 B")
                store.edit(identityB.partition, scope, JSONObject().put("content", MobileContentAdapter.textContent("服务 B 的本地输入😀")))
                assertDrafts(store, identityA, identityB, scope)
                assertStaleHttpIdentity(connection, identityA)

                assertTrue(connection.selectDevice(idA))
                assertFalse(clientB.isConnected)
                val reconnectedA = connection.connect()!!.also { clients.add(it) }
                assertEquals(identityA.partition, reconnectedA.identity!!.partition)
                assertEquals("验收服务 A", connection.savedDevices().first().name)
                assertScope(reconnectedA, first, second)
                assertDrafts(store, identityA, identityB, scope)
                assertStaleHttpIdentity(connection, identityB)

                assertTrue(connection.selectDevice(idB))
                assertFalse(reconnectedA.isConnected)
                val reconnectedB = connection.connect()!!.also { clients.add(it) }
                assertEquals(identityB.partition, reconnectedB.identity!!.partition)
                assertScope(reconnectedB, second, first)
                val restored = MobileConnection(context, schemas, BuildConfig.VERSION_NAME, secrets)
                assertEquals(idB, restored.activeDeviceId())
                assertEquals(setOf("验收服务 A", "验收服务 B"), restored.savedDevices().map { it.name }.toSet())

                reconnectedB.close()
                val uiEvidence = exerciseWorkbench(context, token, store, identityA, identityB, first, second)

                connection.forgetDevice(idB)
                assertFalse(reconnectedB.isConnected)
                assertNull(connection.activeDeviceId())
                assertNull(connection.description())
                assertNull(connection.connect())
                assertEquals(idA, connection.savedDevices().single().id)
                assertFalse(connection.savedDevices().single().selected)
                assertDrafts(store, identityA, identityB, scope)
                assertTrue(connection.selectDevice(idA))
                val retainedA = connection.connect()!!.also { clients.add(it) }
                assertEquals(identityA.partition, retainedA.identity!!.partition)
                assertScope(retainedA, first, second)
                val created = retainedA.call("conversations.get", JSONObject().put("conversationId", uiEvidence.getString("createdConversationId")))
                assertEquals(first.getString("spaceId"), created.getString("spaceId"))
                waitUntil(30000) { retainedA.call("runs.get", JSONObject().put("runId", uiEvidence.getString("createdRunId"))).getString("status") == "completed" }
                marker.writeText(JSONObject().put("deviceCount", 2).put("firstDeviceId", identityA.deviceId).put("secondDeviceId", identityB.deviceId)
                    .put("firstServiceId", identityA.serviceId).put("secondServiceId", identityB.serviceId)
                    .put("partitions", JSONArray().put(identityA.partition).put(identityB.partition))
                    .put("separateScopes", true).put("localDraftIsolation", true).put("staleIdentityRejected", true)
                    .put("previousConnectionClosed", true).put("forgotSelectedWithoutFallback", true).put("remainingDeviceReconnects", true).put("ui", uiEvidence).toString())
            } finally {
                for (partition in partitions) store.writableDatabase.delete("drafts", "partition=? AND scope=?", arrayOf(partition, scope))
            }
        } } finally {
            clients.forEach { it.close() }
            backup.restore()
            if (marker.isFile) marker.writeText(JSONObject(marker.readText()).put("originalIdentityRestored", true).toString())
        }
    }

    private fun exerciseWorkbench(context: Context, token: String, store: LocalStore, firstIdentity: ProductIdentity, secondIdentity: ProductIdentity, first: JSONObject, second: JSONObject): JSONObject {
        val firstText = "服务 A 空间草稿😀 $token"
        val secondText = "服务 B 空间草稿😀 $token"
        val screenshots = JSONArray()
        var receipt: JSONObject? = null
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
            fun input(): String {
                var result = ""
                scenario.onActivity { result = it.findViewById<EditText>(MainActivity.INPUT_ID)?.text?.toString().orEmpty() }
                return result
            }
            fun waitInput() = waitUntil {
                var enabled = false
                scenario.onActivity { enabled = it.findViewById<EditText>(MainActivity.INPUT_ID)?.isEnabled == true }
                enabled
            }
            fun write(text: String, identity: ProductIdentity, space: JSONObject) {
                waitInput()
                scenario.onActivity { it.findViewById<EditText>(MainActivity.INPUT_ID).setText(text) }
                waitUntil { store.drafts().any { it.partition == identity.partition && MobileContentAdapter.text(it.value.getJSONObject("content")) == text && it.value.optString("spaceId") == space.getString("spaceId") } }
            }
            fun capture(name: String, dialog: Boolean = false, pageReady: () -> Boolean) {
                val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
                fun focused(): Boolean {
                    val root = automation.rootInActiveWindow ?: return false
                    if (root.packageName?.toString() != context.packageName || root.window?.isFocused != true) return false
                    var activityFocused = false
                    scenario.onActivity { activityFocused = it.hasWindowFocus() }
                    return dialog || activityFocused
                }
                fun layout(): String {
                    val bounds = mutableListOf<String>()
                    val nodes = ArrayDeque<AccessibilityNodeInfo>()
                    automation.rootInActiveWindow?.let(nodes::addLast)
                    var visited = 0
                    while (nodes.isNotEmpty() && visited++ < 10000) {
                        val node = nodes.removeFirst()
                        if (node.isVisibleToUser) bounds.add("${node.text}|${node.contentDescription}|${Rect().apply { node.getBoundsInScreen(this) }}")
                        repeat(node.childCount) { node.getChild(it)?.let(nodes::addLast) }
                    }
                    return bounds.joinToString("\n")
                }
                val previousFlags = automation.serviceInfo.flags
                automation.serviceInfo = automation.serviceInfo.apply { flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS }
                try {
                    var previous: String? = null
                    var stable = 0
                    waitUntil {
                        if (!pageReady() || !focused()) { stable = 0; previous = null; return@waitUntil false }
                        val frames = CountDownLatch(2)
                        InstrumentationRegistry.getInstrumentation().runOnMainSync {
                            Choreographer.getInstance().postFrameCallback(object : Choreographer.FrameCallback {
                                override fun doFrame(time: Long) {
                                    frames.countDown()
                                    if (frames.count > 0) Choreographer.getInstance().postFrameCallback(this)
                                }
                            })
                        }
                        assertTrue("UI did not render two frames", frames.await(3, TimeUnit.SECONDS))
                        val current = layout()
                        stable = if (current == previous) stable + 1 else 0
                        previous = current
                        stable >= 2 && pageReady() && focused()
                    }
                    val filename = "devices-$token-$name.png"
                    val bitmap = InstrumentationRegistry.getInstrumentation().uiAutomation.takeScreenshot() ?: error("Screenshot unavailable")
                    try { File(context.filesDir, filename).outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) } }
                    finally { bitmap.recycle() }
                    screenshots.put(filename)
                } finally { automation.serviceInfo = automation.serviceInfo.apply { flags = previousFlags } }
            }
            fun awaitComputer(name: String, config: JSONObject) {
                waitUntil(30000) { MobileUiTestDriver.contains("$name，已连接服务") }
                click("搜索任务")
                waitUntil { MobileUiTestDriver.contains(config.getString("assignedTitle")) }
                MobileUiTestDriver.openWorkbench()
            }
            fun switchComputer(current: String, next: String, config: JSONObject, captureSheet: Boolean = false) {
                MobileUiTestDriver.openWorkbench()
                MobileUiTestDriver.clickContaining("$current，")
                waitUntil { MobileUiTestDriver.exists("连接服务") && MobileUiTestDriver.exists(next) }
                if (captureSheet) capture("computer-switch", dialog = true) { MobileUiTestDriver.exists("连接服务") && MobileUiTestDriver.exists(next) }
                click("切换到 $next")
                awaitComputer(next, config)
            }
            fun resume(text: String) {
                MobileUiTestDriver.openWorkbench()
                click("工作台选项"); click("本地草稿")
                click("草稿 · $text"); click("继续编辑")
                waitUntil { input() == text }
            }

            awaitComputer("验收服务 B", second)
            assertFalse(MobileUiTestDriver.contains(first.getString("assignedTitle")))
            switchComputer("验收服务 B", "验收服务 A", first, captureSheet = true)
            capture("workbench") { MobileUiTestDriver.exists("工作台选项") && MobileUiTestDriver.contains("验收服务 A，已连接服务") }
            assertFalse(MobileUiTestDriver.contains(second.getString("assignedTitle")))
            click("工作台选项"); click("空间")
            waitUntil { MobileUiTestDriver.exists(first.getString("spaceName")) }
            assertFalse(MobileUiTestDriver.contains(second.getString("spaceName")))
            capture("spaces") { MobileUiTestDriver.exists(first.getString("spaceName")) && MobileUiTestDriver.exists("全部任务") }
            click("全部任务")
            waitUntil { MobileUiTestDriver.contains(first.getString("assignedTitle")) && MobileUiTestDriver.contains(first.getString("unassignedTitle")) }
            clickId("space-filter"); click("未分配空间")
            waitUntil { MobileUiTestDriver.contains(first.getString("unassignedTitle")) && !MobileUiTestDriver.contains(first.getString("assignedTitle")) }
            capture("unassigned") { MobileUiTestDriver.contains(first.getString("unassignedTitle")) && !MobileUiTestDriver.contains(first.getString("assignedTitle")) }
            click("新任务"); waitInput()
            assertTrue(MobileUiTestDriver.exists("未分配空间"))
            click("返回")
            clickId("space-filter"); click(first.getString("spaceName"))
            waitUntil { MobileUiTestDriver.contains(first.getString("assignedTitle")) && !MobileUiTestDriver.contains(first.getString("unassignedTitle")) }
            capture("space-tasks") { MobileUiTestDriver.contains(first.getString("assignedTitle")) && !MobileUiTestDriver.contains(first.getString("unassignedTitle")) }
            click("新任务"); waitInput()
            assertTrue(MobileUiTestDriver.exists(first.getString("spaceName")))
            write(firstText, firstIdentity, first)
            capture("new-space-task") { input() == firstText && MobileUiTestDriver.exists("任务设置") }

            switchComputer("验收服务 A", "验收服务 B", second)
            click("工作台选项"); click("空间"); click(second.getString("spaceName"))
            waitUntil { MobileUiTestDriver.contains(second.getString("assignedTitle")) && !MobileUiTestDriver.contains(second.getString("unassignedTitle")) }
            click("新任务"); waitInput()
            assertEquals("", input())
            write(secondText, secondIdentity, second)
            switchComputer("验收服务 B", "验收服务 A", first)
            resume(firstText)
            assertTrue(MobileUiTestDriver.exists(first.getString("spaceName")))
            assertTrue(store.drafts().any { it.partition == secondIdentity.partition && MobileContentAdapter.text(it.value.getJSONObject("content")) == secondText })
            clickId("send")
            waitUntil(30000) { store.outbox(firstIdentity.partition).any { it.method == "chat.submitInput" && it.state == "accepted" } }
            receipt = store.outbox(firstIdentity.partition).single { it.method == "chat.submitInput" && it.state == "accepted" }.receipt
            waitUntil(30000) { MobileUiTestDriver.contains("空间验收回复") }
            capture("conversation") { MobileUiTestDriver.contains("空间验收回复") && MobileUiTestDriver.exists("任务设置") }
            switchComputer("验收服务 A", "验收服务 B", second)
            resume(secondText)
            assertTrue(MobileUiTestDriver.exists(second.getString("spaceName")))
            scenario.recreate()
            waitUntil { input() == secondText }
            capture("restored-second-input") { input() == secondText && MobileUiTestDriver.enabled("发送") && MobileUiTestDriver.exists("任务设置") }
            assertEquals(0, store.outbox(secondIdentity.partition).count { it.method == "chat.submitInput" })
        }
        val target = receipt!!.getJSONObject("target")
        return JSONObject().put("topBarDeviceSwitch", true).put("spaceNavigation", true).put("allAndUnassignedFilters", true)
            .put("newTaskInheritsSpace", true).put("localInputIsolation", true).put("inputSurvivesRecreation", true)
            .put("createdConversationId", target.getString("conversationId")).put("createdRunId", target.getString("runId"))
            .put("screenshots", screenshots)
    }

    private fun clickId(id: String) = waitUntil {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow?.let(queue::addLast)
        var visited = 0
        while (queue.isNotEmpty() && visited++ < 10000) {
            val node = queue.removeFirst()
            if (node.isVisibleToUser && (node.viewIdResourceName == id || node.viewIdResourceName?.endsWith(":id/$id") == true)) {
                var target = node
                while (!target.isClickable) target = target.parent ?: return@waitUntil false
                return@waitUntil target.isEnabled && target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
            }
            repeat(node.childCount) { node.getChild(it)?.let(queue::addLast) }
        }
        false
    }

    private class IdentityBackup(private val context: Context, token: String) {
        private val identity = AtomicFile(File(context.noBackupFilesDir, "device-identity.bin"))
        private val bytesFile = File(context.noBackupFilesDir, "device-switch-$token-identity.bin")
        private val manifest = AtomicFile(File(context.noBackupFilesDir, "device-switch-$token-identity.json"))
        fun capture() {
            check(!bytesFile.exists() && !manifest.baseFile.exists())
            val present = identity.baseFile.exists() || File("${identity.baseFile.path}.bak").exists()
            val bytes = if (present) identity.readFully() else ByteArray(0)
            FileOutputStream(bytesFile).use { it.write(bytes); it.fd.sync() }
            save(JSONObject().put("present", present).put("sha256", digest(bytes)).put("partitions", JSONArray()))
        }
        fun addPartition(partition: String) {
            val value = JSONObject(String(manifest.readFully(), Charsets.UTF_8))
            value.getJSONArray("partitions").put(partition)
            save(value)
        }
        fun restore() {
            if (!manifest.baseFile.exists() && !File("${manifest.baseFile.path}.bak").exists()) return
            val value = JSONObject(String(manifest.readFully(), Charsets.UTF_8))
            val bytes = bytesFile.readBytes()
            check(digest(bytes) == value.getString("sha256")) { "Identity backup checksum changed" }
            if (value.getBoolean("present")) {
                val output = identity.startWrite()
                try { output.write(bytes); identity.finishWrite(output) } catch (failure: Exception) { identity.failWrite(output); throw failure }
                assertArrayEquals(bytes, identity.readFully())
            } else identity.delete()
            val partitions = value.getJSONArray("partitions")
            LocalStore(context).use { store ->
                val navigation = context.getSharedPreferences("mobile-navigation", Context.MODE_PRIVATE).edit()
                repeat(partitions.length()) { index ->
                    val partition = partitions.getString(index)
                    require(partition.isNotBlank() && partition != "unpaired-local")
                    store.writableDatabase.delete("drafts", "partition=?", arrayOf(partition))
                    store.writableDatabase.delete("outbox", "partition=?", arrayOf(partition))
                    navigation.remove(partition)
                }
                check(navigation.commit())
            }
        }
        private fun save(value: JSONObject) {
            val output = manifest.startWrite()
            try { output.write(value.toString().toByteArray(Charsets.UTF_8)); manifest.finishWrite(output) } catch (failure: Exception) { manifest.failWrite(output); throw failure }
        }
        private fun digest(value: ByteArray) = MessageDigest.getInstance("SHA-256").digest(value).joinToString("") { "%02x".format(it) }
    }
    private fun assertScope(client: ProductClient, expected: JSONObject, other: JSONObject) {
        val values = client.call("spaces.list", JSONObject()).getJSONArray("items")
        val spaces = (0 until values.length()).map { values.getJSONObject(it) }
        assertTrue(spaces.any { it.getString("id") == expected.getString("spaceId") && it.getString("name") == expected.getString("spaceName") })
        assertFalse(spaces.any { it.getString("id") == other.getString("spaceId") || it.getString("name") == other.getString("spaceName") })
    }
    private fun assertDrafts(store: LocalStore, first: ProductIdentity, second: ProductIdentity, scope: String) {
        assertEquals("服务 A 的本地输入😀", MobileContentAdapter.text(store.draft(first.partition, scope)!!.value.getJSONObject("content")))
        assertEquals("服务 B 的本地输入😀", MobileContentAdapter.text(store.draft(second.partition, scope)!!.value.getJSONObject("content")))
    }
    private fun assertStaleHttpIdentity(connection: MobileConnection, stale: ProductIdentity) {
        try { connection.http(stale) { _, _ -> fail("A stale identity reached the current computer transport") }; fail("A stale identity was accepted") }
        catch (failure: ProtocolFailure) { assertEquals("DATA_GENERATION_CHANGED", failure.code) }
    }
}
