package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import android.app.Activity
import android.app.Instrumentation
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.SystemClock
import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.network.MobileFiles
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.DocumentExport
import app.uselexora.mobile.storage.LocalFiles
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.TransferStore
import app.uselexora.mobile.ui.MainActivity
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class FileWorkflowInstrumentedTest {
    private val instrumentation get() = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private fun uri(name: String) = Uri.parse("content://app.uselexora.mobile.dev.test.file-workflow/$name")
    private fun copy(): File = File(File(context.filesDir, "exports").apply { mkdirs() }, "${UUID.randomUUID()}-保存.txt").apply { writeText("完整中文😀") }
    @Test fun documentProviderReceivesExactBytesAndTruncatesPreviousContent() {
        context.contentResolver.call(uri("output"), "reset", null, null)
        val source = copy()
        try {
            DocumentExport(context).save(source, uri("output"))
            assertArrayEquals(source.readBytes(), context.contentResolver.openInputStream(uri("output"))!!.use { it.readBytes() })
            assertEquals("完整中文😀", source.readText())
        } finally { source.delete() }
    }
    @Test fun failedExportsPreserveSourceOnRevocationMissingUriAndProviderQuota() {
        val source = copy()
        try {
            val ownUri = androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.files", source)
            for (target in listOf(ownUri, Uri.fromFile(source))) {
                assertEquals("DOCUMENT_SAVE_FAILED", (runCatching { DocumentExport(context).save(source, target) }.exceptionOrNull() as ProtocolFailure).code)
                assertEquals("完整中文😀", source.readText())
            }
            for (target in listOf("denied", "missing", "full")) {
                val failure = runCatching { DocumentExport(context).save(source, uri(target)) }.exceptionOrNull()
                assertEquals(target, "DOCUMENT_SAVE_FAILED", (failure as? ProtocolFailure)?.code)
                if (target == "full") assertTrue(generateSequence(failure) { it.cause }.any { it.message?.contains("ENOSPC") == true })
                assertEquals("完整中文😀", source.readText())
            }
        } finally { source.delete() }
    }
    @Test fun expiredProviderPermissionsDoNotLeaveTransfersOrLoseDrafts() {
        val owner = "provider-${UUID.randomUUID()}"
        LocalStore(context).use { store -> TransferStore(context).use { transfers ->
            val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
            val files = MobileFiles(context, transfers, store, MobileConnection(context, schemas, BuildConfig.VERSION_NAME))
            store.edit(owner, "global", JSONObject().put("content", MobileContentAdapter.textContent("保留输入")))
            for (path in listOf("denied-query", "denied", "missing")) {
                val failure = runCatching { files.stage(uri(path), owner, "global", JSONObject().put("kind", "global")) }.exceptionOrNull()
                assertEquals("LOCAL_FILE_FAILED", (failure as? ProtocolFailure)?.code)
                assertTrue(transfers.list(owner).isEmpty())
                assertEquals("保留输入", MobileContentAdapter.text(store.draft(owner, "global")!!.value.getJSONObject("content")))
            }
            val copied = files.stage(uri("source"), owner, "global", JSONObject().put("kind", "global"))
            TransferStore(context).use { reopened ->
                val persisted = reopened.list(owner).single()
                assertEquals("global", persisted.getJSONObject("targetScope").getString("kind"))
                assertEquals("global", persisted.getString("scope"))
                assertEquals(copied.getString("id"), persisted.getString("id"))
            }
            assertEquals("原附件😀", File(copied.getString("path")).readText())
            File(copied.getString("path")).delete()
        } }
    }
    @Test fun providerMetadataCannotBypassFormatOrStreamSizeLimits() {
        val owner = "provider-limits-${UUID.randomUUID()}"
        LocalStore(context).use { store -> TransferStore(context).use { transfers ->
            val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
            val files = MobileFiles(context, transfers, store, MobileConnection(context, schemas, BuildConfig.VERSION_NAME))
            store.edit(owner, "global", JSONObject().put("content", MobileContentAdapter.textContent("拒绝附件仍保留输入")))
            val staging = File(context.filesDir, "staging").apply { mkdirs() }
            val before = staging.list()!!.toSet()
            for ((path, code) in mapOf("unknown" to "FILE_TYPE_UNSUPPORTED", "oversize" to "FILE_TOO_LARGE")) {
                val error = runCatching { files.stage(uri(path), owner, "global", JSONObject().put("kind", "global")) }.exceptionOrNull()
                assertEquals(code, (error as? ProtocolFailure)?.code)
                assertEquals(before, staging.list()!!.toSet())
                assertTrue(transfers.list(owner).isEmpty())
            }
            assertEquals("拒绝附件仍保留输入", MobileContentAdapter.text(store.draft(owner, "global")!!.value.getJSONObject("content")))
        } }
    }
    private fun withDownload(block: (File, JSONObject) -> Unit) {
        val source = copy()
        val id = source.name.substringBefore("-保存.txt")
        val record = JSONObject().put("id", id).put("partition", "export-$id").put("kind", "download").put("state", "ready").put("path", source.absolutePath)
            .put("prepared", JSONObject().put("name", "保存验证-$id.txt").put("mimeType", "text/plain"))
        TransferStore(context).use { it.save(record) }
        try { block(source, record) } finally { source.delete() }
    }
    @Test fun nativePickerAndSaveCancellationKeepTheOriginalFile() = withDownload { source, record ->
        ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("fixture", true)).use {
            click("新任务"); click("添加附件"); click("选择文件")
            waitFor { instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString()?.contains("documentsui") == true }
            assertTrue(instrumentation.uiAutomation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK))
            waitText("已取消添加附件")
            openSave(record)
            waitFor { instrumentation.uiAutomation.rootInActiveWindow?.packageName?.toString()?.contains("documentsui") == true }
            assertTrue(instrumentation.uiAutomation.performGlobalAction(AccessibilityService.GLOBAL_ACTION_BACK))
            waitText("已取消保存")
            assertTrue(source.exists())
        }
    }
    @Test fun failedSystemSaveNeverDisplaysSuccessAndActiveSaveProtectsTheSource() = withDownload { source, record ->
        LocalStore(context).use { store -> TransferStore(context).use { transfers ->
            val files = LocalFiles(context, transfers, store) { setOf(source.absolutePath) }
            assertFalse(files.list().single { it.record.getString("id") == record.getString("id") }.removable)
            assertEquals("LOCAL_FILE_IN_USE", (runCatching { files.remove(record) }.exceptionOrNull() as ProtocolFailure).code)
        } }
        val monitor = Instrumentation.ActivityMonitor(IntentFilter(Intent.ACTION_CREATE_DOCUMENT).apply { addCategory(Intent.CATEGORY_OPENABLE); addDataType("*/*") }, Instrumentation.ActivityResult(Activity.RESULT_OK, Intent().setData(uri("full"))), true)
        try { ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("fixture", true)).use {
            instrumentation.addMonitor(monitor)
            openSave(record)
            waitText("未能完整保存到所选位置")
            assertFalse(MobileUiTestDriver.contains("文件已保存到所选位置"))
            assertEquals("完整中文😀", source.readText())
        } } finally { instrumentation.removeMonitor(monitor) }
    }
    private fun openSave(record: JSONObject) { MobileUiTestDriver.openFiles(); click("本机文件与清理"); click(record.getJSONObject("prepared").getString("name")); click("保存到文件") }
    private fun waitText(text: String) = waitFor { MobileUiTestDriver.contains(text) }
    private fun click(value: String) = MobileUiTestDriver.click(value)
    private fun waitFor(condition: () -> Boolean) {
        val deadline = SystemClock.uptimeMillis() + 15000
        while (SystemClock.uptimeMillis() < deadline) { if (condition()) return; SystemClock.sleep(50) }
        if (!condition()) MobileUiTestDriver.fail("File workflow did not reach expected state")
    }
}
