package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import android.app.Instrumentation
import android.app.UiAutomation
import android.provider.MediaStore
import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Process
import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.EditText
import androidx.core.content.FileProvider
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.rule.GrantPermissionRule
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.TransferStore
import app.uselexora.mobile.ui.MainActivity
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.Rule
import org.junit.runner.RunWith
import java.io.File
import java.security.MessageDigest
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class SystemFileInstrumentedTest {
    @get:Rule val cameraPermission: GrantPermissionRule = GrantPermissionRule.grant(Manifest.permission.CAMERA)
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val provider = Uri.parse("content://app.uselexora.mobile.dev.test.file-workflow")
    private val owner = "fixture:service:profile:generation:device"
    private fun report() = JSONObject(context.contentResolver.call(provider, "receiver-report", null, null)!!.getString("report")!!)
    private fun reset(other: File? = null) { context.contentResolver.call(provider, "receiver-reset", other?.let { FileProvider.getUriForFile(context, "${context.packageName}.files", it).toString() }, null) }
    private fun cameraReceiver(block: () -> Unit) {
        val monitor = object : Instrumentation.ActivityMonitor() {
            override fun onStartActivity(intent: Intent): Instrumentation.ActivityResult? {
                if (intent.action == MediaStore.ACTION_IMAGE_CAPTURE) intent.setClassName("app.uselexora.mobile.dev.test", "app.uselexora.mobile.FileReceiverActivity")
                return null
            }
        }
        instrumentation.addMonitor(monitor)
        try { block() } finally { instrumentation.removeMonitor(monitor) }
    }
    private fun activity() = ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("fixture", true)).also { click("新任务") }
    private fun hash(file: File) = MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }
    private fun download(): Pair<File, String> {
        val id = UUID.randomUUID().toString()
        val name = "共享验证-$id.txt"
        val file = File(File(context.filesDir, "exports").apply { mkdirs() }, "$id-$name").apply { writeText("独立接收进程读取完整文件😀") }
        TransferStore(context).use { it.save(JSONObject().put("id", id).put("partition", owner).put("kind", "download").put("state", "ready").put("path", file.absolutePath)
            .put("prepared", JSONObject().put("name", name).put("mimeType", "text/plain"))) }
        return file to name
    }
    private fun share(name: String) { MobileUiTestDriver.openFiles(); click("本机文件与清理"); click(name); click("分享文件") }
    @Test fun realShareReceiverGetsOnlyTemporaryReadAccessToTheSelectedFile() {
        val (source, name) = download(); val (other, _) = download()
        val expected = hash(source)
        try {
            reset(other)
            activity().use {
                share(name); chooseReceiver("Share receiver ready")
                val result = report()
                assertFalse(result.toString(), result.has("error"))
                assertNotEquals(Process.myUid(), result.getInt("uid"))
                assertEquals(Intent.ACTION_SEND, result.getString("action"))
                assertEquals(expected, result.getString("sha256"))
                assertTrue(result.getBoolean("clipMatches"))
                assertFalse(result.getBoolean("writable"))
                assertFalse(result.getBoolean("otherReadable"))
                assertEquals(0, result.getInt("flags") and (Intent.FLAG_GRANT_WRITE_URI_PERMISSION or Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION or Intent.FLAG_GRANT_PREFIX_URI_PERMISSION))
                assertEquals(expected, hash(source))
                click("Close receiver")
            }
            val uri = report().getString("uri")
            waitFor { context.contentResolver.call(provider, "receiver-probe", uri, null)?.getBoolean("readable") == false }
            assertEquals(expected, hash(source))
        } finally { source.delete(); other.delete() }
    }
    @Test fun cancelledShareChooserDoesNotDeliverOrRemoveTheOriginal() {
        val (source, name) = download()
        try {
            reset()
            activity().use {
                share(name)
                waitFor { instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString() != context.packageName }
                assertTrue(instrumentation.uiAutomation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK))
                waitText("新任务")
                assertEquals(0, report().length())
                assertEquals("独立接收进程读取完整文件😀", source.readText())
            }
        } finally { source.delete() }
    }
    @Test fun cameraUriResultSurvivesActivityRecreationAndKeepsTheOriginalDraft() = cameraReceiver {
        assertEquals("Grant CAMERA before running camera contract tests", PackageManager.PERMISSION_GRANTED, context.checkSelfPermission(Manifest.permission.CAMERA))
        reset()
        TransferStore(context).use { transfers ->
            val before = transfers.all().map { it.getString("id") }.toSet()
            try {
                activity().use { scenario ->
                    waitFor { var ready = false; scenario.onActivity { ready = it.findViewById<EditText>(MainActivity.INPUT_ID)?.isEnabled == true }; ready }
                    var original: MainActivity? = null
                    scenario.onActivity { original = it; it.findViewById<EditText>(MainActivity.INPUT_ID).setText("拍照期间保留原稿😀") }
                    click("添加附件"); click("拍照"); waitText("Capture receiver ready")
                    val record = transfers.list(owner).single { it.optString("kind") == "capture" && it.getString("id") !in before }
                    assertTrue(record.getString("scope").startsWith("draft:"))
                    val receiverInstance = report().getString("instanceId")
                    assertTrue(instrumentation.uiAutomation.setRotation(UiAutomation.ROTATION_FREEZE_90))
                    waitFor { report().optString("instanceId") != receiverInstance }
                    instrumentation.waitForIdleSync()
                    waitText("Capture receiver ready")
                    click("Return captured photo")
                    waitFor { transfers.list(owner).any { it.optString("sourceCaptureId") == record.getString("id") } }
                    val upload = transfers.list(owner).single { it.optString("sourceCaptureId") == record.getString("id") }
                    val result = report()
                    assertFalse(result.toString(), result.has("error"))
                    assertNotEquals(Process.myUid(), result.getInt("uid"))
                    assertTrue(result.getBoolean("clipMatches"))
                    assertEquals(result.getString("sha256"), hash(File(upload.getString("path"))))
                    assertEquals(owner, upload.getString("partition"))
                    assertEquals("task", upload.getJSONObject("targetScope").getString("kind"))
                    assertEquals(record.getString("scope"), upload.getString("scope"))
                    assertFalse(File(record.getString("path")).exists())
                    LocalStore(context).use { assertEquals("拍照期间保留原稿😀", MobileContentAdapter.text(it.draft(owner, record.getString("scope"))!!.value.getJSONObject("content"))) }
                    scenario.onActivity { assertNotSame(original, it); assertEquals("拍照期间保留原稿😀", it.findViewById<EditText>(MainActivity.INPUT_ID).text.toString()) }
                }
            } finally { instrumentation.uiAutomation.setRotation(UiAutomation.ROTATION_FREEZE_0); instrumentation.uiAutomation.setRotation(UiAutomation.ROTATION_UNFREEZE); transfers.all().filter { it.getString("id") !in before }.forEach { File(it.getString("path")).delete() } }
        }
    }
    @Test fun cancelledCameraDoesNotCreateAnUploadOrChangeTheDraft() = cameraReceiver {
        assertEquals(PackageManager.PERMISSION_GRANTED, context.checkSelfPermission(Manifest.permission.CAMERA))
        reset()
        TransferStore(context).use { transfers ->
            val before = transfers.all().map { it.getString("id") }.toSet()
            activity().use {
                click("添加附件"); click("拍照"); waitText("Capture receiver ready"); click("Cancel capture")
                waitText("已取消添加附件")
                waitFor { transfers.list(owner).filter { it.getString("id") !in before }.all { it.optString("state") == "cancelled" } }
                val new = transfers.list(owner).filter { it.getString("id") !in before }
                assertEquals(1, new.size)
                assertEquals("capture", new.single().getString("kind"))
                assertFalse(File(new.single().getString("path")).exists())
            }
        }
    }
    private fun chooseReceiver(ready: String) {
        click("Lexora File Receiver")
        waitFor {
            val root = instrumentation.uiAutomation.rootInActiveWindow ?: return@waitFor false
            if (root.findAccessibilityNodeInfosByText(ready).isNotEmpty()) true
            else {
                root.findAccessibilityNodeInfosByText("Just once").firstOrNull()?.performAction(AccessibilityNodeInfo.ACTION_CLICK)
                false
            }
        }
    }
    private fun waitText(value: String) = waitFor { MobileUiTestDriver.exists(value, prefix = true) }
    private fun click(value: String) = MobileUiTestDriver.click(value)
    private fun waitFor(condition: () -> Boolean) = MobileUiTestDriver.waitUntil(condition = condition)
}
