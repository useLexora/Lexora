package app.uselexora.mobile

import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Rect
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.util.AtomicFile
import android.view.Choreographer
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.MobileUiTestDriver.click
import app.uselexora.mobile.MobileUiTestDriver.waitUntil
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.protocol.CommandOutbox
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.SecretStore
import app.uselexora.mobile.ui.MainActivity
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
class QuestionAnswerInstrumentedTest {
    @Test fun nativeAnswersSurviveRecreationAndRespectTheDesktopWinner() {
        val token = InstrumentationRegistry.getArguments().getString("questionAnswerToken")
        assumeTrue(token?.matches(Regex("[a-f0-9-]{36}")) == true)
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val backup = IdentityBackup(context, token!!)
        if (InstrumentationRegistry.getArguments().getString("questionAnswerRestoreOnly") == "true") {
            backup.restore()
            return
        }
        val config = JSONObject(ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand("cat /data/local/tmp/lexora-questions-$token.json")).bufferedReader().use { it.readText() })
        val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
        val secrets = SecretStore(context)
        val connection = MobileConnection(context, schemas, BuildConfig.VERSION_NAME, secrets)
        val cases = config.getJSONArray("cases")
        val answerText = "手机选择与补充😀 $token"
        val staleText = "此手机旧回答不得投递 $token"
        val marker = File(context.filesDir, "questions-$token.json")
        marker.delete()
        backup.capture()
        try {
            secrets.clear()
            val identity = connection.pair(config.getJSONObject("pairing").toString())
            backup.addPartition(identity.partition)
            connection.renameDevice(connection.activeDeviceId()!!, "问答验收服务")
            LocalStore(context).use { store ->
                val verification = connection.connect()!!
                try { assertOldInstanceRetryPreserved(verification, store, cases.getJSONObject(0), token) }
                finally { verification.close() }
                ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java)).use { scenario ->
                    MobileUiTestDriver.awaitConnected()
                    val first = cases.getJSONObject(0)
                    MobileUiTestDriver.openTask(first.getString("title"))
                    openQuestion()
                    assertFalse(MobileUiTestDriver.enabled("提交回答"))
                    click("连接恢复（建议）")
                    click("文件操作")
                    setAnswerText(answerText)
                    val key = identity.partition + ":" + first.getString("requestId")
                    val drafts = context.getSharedPreferences("question-inputs", Context.MODE_PRIVATE)
                    waitUntil { drafts.getString(key, null)?.let { JSONObject(it).getJSONArray("answers").getJSONObject(0).optString("text") == answerText } == true }
                    val before = drafts.getString(key, null)!!
                    capture(context, token, "filled", answerText)
                    scenario.recreate()
                    openQuestion()
                    waitUntil { MobileUiTestDriver.contains(answerText) }
                    assertEquals(before, drafts.getString(key, null))
                    assertTrue(checked("连接恢复"))
                    assertTrue(checked("文件操作"))
                    assertFalse(checked("仅审查源码"))
                    capture(context, token, "restored-answer", answerText)
                    click("提交回答")
                    waitUntil(30000) { store.outbox(identity.partition).any { it.method == "questions.answer" && it.state == "accepted" && it.receipt?.getJSONObject("target")?.optString("questionId") == first.getString("requestId") } }
                    waitUntil { !MobileUiTestDriver.exists("提交回答") }
                    checkpoint(context, token, 0, "done", JSONObject().put("requestId", first.getString("requestId")).put("activityRecreated", true).put("selectedOptionIds", JSONArray().put("connection").put("files")).put("text", answerText))
                    waitUntil(60000) { File(context.filesDir, "questions-$token-0-resume.json").isFile }
                    waitUntil(30000) { MobileUiTestDriver.contains("问题验收完成 0") }
                    capture(context, token, "delivered", "问题验收完成 0")

                    val second = cases.getJSONObject(1)
                    MobileUiTestDriver.openTask(second.getString("title"))
                    openQuestion()
                    click("手机先填但不提交")
                    setAnswerText(staleText)
                    capture(context, token, "awaiting-desktop", staleText)
                    checkpoint(context, token, 1, "ready", JSONObject().put("requestId", second.getString("requestId")).put("dialogOpen", true))
                    waitUntil(60000) { !MobileUiTestDriver.exists("提交回答") }
                    waitUntil(60000) { File(context.filesDir, "questions-$token-1-resume.json").isFile }
                    waitUntil(30000) { MobileUiTestDriver.contains("问题验收完成 1") }
                    assertEquals(1, store.outbox(identity.partition).count { it.method == "questions.answer" })
                    capture(context, token, "desktop-winner", "问题验收完成 1")
                    checkpoint(context, token, 1, "done", JSONObject().put("requestId", second.getString("requestId")).put("staleDialogClosed", true).put("noStaleCommand", true))
                    marker.writeText(JSONObject().put("deviceId", identity.deviceId).put("partition", identity.partition).put("activityRecreated", true).put("multipleChoicesAndText", true).put("oldInstanceRetryPreserved", true).put("staleDialogClosed", true).put("noStaleCommand", true).toString())
                }
            }
        }
        finally {
            backup.restore()
            if (marker.isFile) marker.writeText(JSONObject(marker.readText()).put("originalIdentityRestored", true).toString())
        }
    }

    private fun assertOldInstanceRetryPreserved(client: ProductClient, store: LocalStore, question: JSONObject, token: String) {
        val identity = client.identity!!
        val commandId = store.newId()
        val lookup = JSONObject().put("dataGeneration", identity.dataGeneration).put("commandId", commandId)
        assertEquals("not_found", client.call("commands.get", lookup).getString("lookup"))
        val intent = JSONObject().put("conversationId", question.getString("conversationId"))
            .put("branchId", question.getString("branchId")).put("requestId", question.getString("requestId"))
            .put("answers", JSONArray().put(JSONObject().put("questionId", "coverage").put("selectedOptionIds", JSONArray().put("connection")).put("text", "旧实例待确认答案 $token")))
        val envelope = JSONObject().put("commandId", commandId).put("dataGeneration", identity.dataGeneration)
            .put("expectedServiceInstanceId", "retired-instance-$token").put("intent", intent)
        client.validateRequest("questions.answer", envelope)
        val original = envelope.toString()
        val queued = store.queue(identity.partition, "questions.answer", envelope)
        try {
            CommandOutbox(store).retry(client, queued)
            fail("An undecided command from an old service instance was retried")
        } catch (failure: ProtocolFailure) {
            assertEquals("SERVICE_INSTANCE_CHANGED", failure.code)
        }
        val retained = store.outbox(identity.partition).single { it.id == commandId }
        assertEquals("not_found", retained.state)
        assertNull(retained.receipt)
        store.readableDatabase.rawQuery("SELECT envelope FROM outbox WHERE id=? AND partition=?", arrayOf(commandId, identity.partition)).use { row ->
            assertTrue(row.moveToFirst())
            assertEquals(original, row.getString(0))
        }
        assertEquals("not_found", client.call("commands.get", lookup).getString("lookup"))
        val scope = JSONObject().put("conversationId", question.getString("conversationId")).put("branchId", question.getString("branchId"))
        val requests = client.call("questions.list", scope).getJSONArray("items")
        val pending = (0 until requests.length()).map { requests.getJSONObject(it) }.single { it.getString("id") == question.getString("requestId") }
        assertEquals("pending", pending.getString("status"))
        assertTrue(pending.isNull("response"))
        assertEquals(1, store.writableDatabase.delete("outbox", "id=? AND partition=?", arrayOf(commandId, identity.partition)))
    }

    private fun openQuestion() {
        waitUntil(30000) { node { it.isVisibleToUser && (it.viewIdResourceName == "answer-question" || it.viewIdResourceName?.endsWith(":id/answer-question") == true) } != null }
        waitUntil {
            var target = node { it.isVisibleToUser && (it.viewIdResourceName == "answer-question" || it.viewIdResourceName?.endsWith(":id/answer-question") == true) } ?: return@waitUntil false
            while (!target.isClickable) target = target.parent ?: return@waitUntil false
            target.isEnabled && target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        }
        waitUntil { MobileUiTestDriver.exists("提交回答") }
    }

    private fun setAnswerText(text: String) = waitUntil {
        val edit = node { it.isVisibleToUser && it.className?.toString() == "android.widget.EditText" } ?: return@waitUntil false
        edit.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) })
    }
    private fun checked(label: String): Boolean = node { it.isVisibleToUser && it.className?.toString() == "android.widget.CheckBox" && it.text?.toString()?.startsWith(label) == true }?.isChecked == true
    private fun node(predicate: (AccessibilityNodeInfo) -> Boolean): AccessibilityNodeInfo? {
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow?.let(queue::addLast)
        var visited = 0
        while (queue.isNotEmpty() && visited++ < 10000) {
            val current = queue.removeFirst()
            if (predicate(current)) return current
            repeat(current.childCount) { current.getChild(it)?.let(queue::addLast) }
        }
        return null
    }
    private fun checkpoint(context: Context, token: String, phase: Int, stage: String, value: JSONObject) {
        val target = AtomicFile(File(context.filesDir, "questions-$token-$phase-$stage.json"))
        val output = target.startWrite()
        try { output.write(value.toString().toByteArray(Charsets.UTF_8)); target.finishWrite(output) } catch (failure: Exception) { target.failWrite(output); throw failure }
    }
    private fun capture(context: Context, token: String, name: String, expectedText: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val automation = instrumentation.uiAutomation
        fun ready(): Boolean {
            val root = automation.rootInActiveWindow ?: return false
            return root.packageName?.toString() == context.packageName && root.window?.isFocused == true && MobileUiTestDriver.contains(expectedText)
        }
        fun layout(): String {
            val visible = mutableListOf<String>()
            node {
                if (it.isVisibleToUser) visible.add("${it.text}|${it.contentDescription}|${Rect().apply { it.getBoundsInScreen(this) }}")
                false
            }
            return visible.joinToString("\n")
        }
        val previousFlags = automation.serviceInfo.flags
        automation.serviceInfo = automation.serviceInfo.apply { flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS }
        try {
            var previous: String? = null
            var stable = 0
            waitUntil {
                if (!ready()) { stable = 0; previous = null; return@waitUntil false }
                instrumentation.waitForIdleSync()
                val frames = CountDownLatch(2)
                instrumentation.runOnMainSync {
                    Choreographer.getInstance().postFrameCallback(object : Choreographer.FrameCallback {
                        override fun doFrame(time: Long) {
                            frames.countDown()
                            if (frames.count > 0) Choreographer.getInstance().postFrameCallback(this)
                        }
                    })
                }
                assertTrue("Question UI did not render two frames", frames.await(3, TimeUnit.SECONDS))
                val current = layout()
                stable = if (current == previous) stable + 1 else 0
                previous = current
                stable >= 2 && ready()
            }
            val image = automation.takeScreenshot() ?: error("Screenshot unavailable")
            try { File(context.filesDir, "questions-$token-$name.png").outputStream().use { assertTrue(image.compress(Bitmap.CompressFormat.PNG, 100, it)) } }
            finally { image.recycle() }
        }
        finally { automation.serviceInfo = automation.serviceInfo.apply { flags = previousFlags } }
    }

    private class IdentityBackup(private val context: Context, token: String) {
        private val identity = AtomicFile(File(context.noBackupFilesDir, "device-identity.bin"))
        private val bytesFile = File(context.noBackupFilesDir, "question-answer-$token-identity.bin")
        private val manifest = AtomicFile(File(context.noBackupFilesDir, "question-answer-$token-identity.json"))
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
                val answers = context.getSharedPreferences("question-inputs", Context.MODE_PRIVATE)
                val answerEdit = answers.edit()
                val prefixes = (0 until partitions.length()).map { partitions.getString(it) + ":" }
                answers.all.keys.filter { key -> prefixes.any { prefix -> key.startsWith(prefix) } }.forEach { answerEdit.remove(it) }
                check(answerEdit.commit())
            }
        }
        private fun save(value: JSONObject) {
            val output = manifest.startWrite()
            try { output.write(value.toString().toByteArray(Charsets.UTF_8)); manifest.finishWrite(output) } catch (failure: Exception) { manifest.failWrite(output); throw failure }
        }
        private fun digest(value: ByteArray) = MessageDigest.getInstance("SHA-256").digest(value).joinToString("") { "%02x".format(it) }
    }
}
