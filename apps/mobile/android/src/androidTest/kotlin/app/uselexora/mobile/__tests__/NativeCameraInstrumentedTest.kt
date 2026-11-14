package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import android.Manifest
import android.accessibilityservice.AccessibilityServiceInfo
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.BitmapFactory
import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityNodeInfo
import android.widget.EditText
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.TransferStore
import app.uselexora.mobile.ui.MainActivity
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class NativeCameraInstrumentedTest {
    @Test fun permissionDenialGrantCancellationAndSystemCameraCapturePreserveInput() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("nativeCamera") == "true")
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val automation = instrumentation.uiAutomation
        automation.serviceInfo = automation.serviceInfo.apply { flags = flags or AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS }
        assertEquals("Start this test with CAMERA revoked and permission flags reset", PackageManager.PERMISSION_DENIED, context.checkSelfPermission(Manifest.permission.CAMERA))
        val owner = "fixture:service:profile:generation:device"
        TransferStore(context).use { transfers ->
            val before = transfers.all().map { it.getString("id") }.toSet()
            try {
                ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("fixture", true)).use { scenario ->
                    click("新任务")
                    waitFor { var ready = false; scenario.onActivity { ready = it.findViewById<EditText>(MainActivity.INPUT_ID)?.isEnabled == true }; ready }
                    scenario.onActivity { it.findViewById<EditText>(MainActivity.INPUT_ID).setText("系统相机拒权与拍照保留😀") }
                    openCamera(); clickId("com.android.permissioncontroller:id/permission_deny_button")
                    waitText("未授权相机")
                    assertEquals(before, transfers.all().map { it.getString("id") }.toSet())
                    openCamera(); clickId("com.android.permissioncontroller:id/permission_allow_foreground_only_button")
                    waitFor { automation.rootInActiveWindow?.packageName == "com.android.camera2" }
                    assertTrue(instrumentation.uiAutomation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK))
                    waitText("已取消添加附件")
                    assertEquals(PackageManager.PERMISSION_GRANTED, context.checkSelfPermission(Manifest.permission.CAMERA))
                    openCamera()
                    clickId("com.android.camera2:id/shutter_button")
                    clickId("com.android.camera2:id/done_button")
                    waitFor { transfers.list(owner).any { it.optString("kind") == "upload" && it.getString("id") !in before } }
                    val upload = transfers.list(owner).single { it.optString("kind") == "upload" && it.getString("id") !in before }
                    val file = File(upload.getString("path"))
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeFile(file.absolutePath, bounds)
                    assertTrue("System camera did not produce a usable image", bounds.outWidth > 0 && bounds.outHeight > 0)
                    assertEquals("task", upload.getJSONObject("targetScope").getString("kind"))
                    assertEquals("draft:${upload.getJSONObject("targetScope").getString("draftId")}", upload.getString("scope"))
                    assertEquals(file.length(), upload.getJSONObject("file").getLong("sizeBytes"))
                    LocalStore(context).use { assertEquals("系统相机拒权与拍照保留😀", MobileContentAdapter.text(it.draft(owner, upload.getString("scope"))!!.value.getJSONObject("content"))) }
                }
            } finally { transfers.all().filter { it.getString("id") !in before }.forEach { File(it.getString("path")).delete() } }
        }
    }
    private fun openCamera() { click("添加附件"); click("拍照") }
    private fun root() = InstrumentationRegistry.getInstrumentation().uiAutomation.rootInActiveWindow
    private fun waitText(value: String) = waitFor { MobileUiTestDriver.exists(value, prefix = true) }
    private fun click(value: String) = MobileUiTestDriver.click(value)
    private fun clickId(value: String) = waitFor { root()?.findAccessibilityNodeInfosByViewId(value)?.firstOrNull()?.let(::press) ?: false }
    private fun press(original: AccessibilityNodeInfo): Boolean { var node = original; while (!node.isClickable) node = node.parent ?: return false; return node.performAction(AccessibilityNodeInfo.ACTION_CLICK) }
    private fun waitFor(condition: () -> Boolean) = MobileUiTestDriver.waitUntil(condition = condition)
}
