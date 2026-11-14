package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import android.content.Intent
import android.graphics.Bitmap
import android.os.SystemClock
import android.view.accessibility.AccessibilityNodeInfo
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.network.MobileConnection
import app.uselexora.mobile.network.MobileFiles
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.*
import app.uselexora.mobile.ui.MainActivity
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class PhotoRecoveryInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun target(owner: String) = JSONObject().put("partition", owner).put("scope", "global").put("targetScope", JSONObject().put("kind", "global"))
    private fun image(file: File) { val bitmap = Bitmap.createBitmap(12, 12, Bitmap.Config.ARGB_8888); file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it) }; bitmap.recycle() }
    @Test fun failedPhotoStagingSurvivesReopenAndRetriesWithoutDuplicateUpload() {
        val owner = "photo-${UUID.randomUUID()}"
        val filler = File(File(context.filesDir, "staging").apply { mkdirs() }, UUID.randomUUID().toString())
        var capture: JSONObject? = null
        var staged: JSONObject? = null
        try {
            TransferStore(context).use { transfers -> LocalStore(context).use { store ->
                val photos = PhotoStore(context, transfers)
                val record = photos.create(target(owner)); capture = record
                image(photos.file(record))
                store.edit(owner, "global", JSONObject().put("content", MobileContentAdapter.textContent("照片失败也保留输入😀")))
                RandomAccessFile(filler, "rw").use { it.setLength(FileBudget(context.filesDir).capacity().remaining) }
                val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
                val files = MobileFiles(context, transfers, store, MobileConnection(context, schemas, BuildConfig.VERSION_NAME))
                assertEquals("LOCAL_CACHE_FULL", (runCatching { files.stageCapture(record) }.exceptionOrNull() as ProtocolFailure).code)
                assertTrue(photos.file(record).length() > 0)
                assertEquals("captured", photos.current(record).getString("state"))
                assertEquals(1, transfers.list(owner).size)
            } }
            filler.delete()
            TransferStore(context).use { transfers -> LocalStore(context).use { store ->
                val photos = PhotoStore(context, transfers)
                val record = photos.current(capture!!)
                val bytes = photos.file(record).readBytes()
                val schemas = ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
                val files = MobileFiles(context, transfers, store, MobileConnection(context, schemas, BuildConfig.VERSION_NAME))
                val transfer = files.stageCapture(record); staged = transfer
                assertArrayEquals(bytes, File(transfer.getString("path")).readBytes())
                assertFalse(photos.file(record).exists())
                assertEquals("copied", photos.current(record).getString("state"))
                assertEquals(transfer.getString("id"), files.stageCapture(record).getString("id"))
                assertEquals(1, transfers.list(owner).count { it.optString("kind") == "upload" })
                assertEquals("照片失败也保留输入😀", MobileContentAdapter.text(store.draft(owner, "global")!!.value.getJSONObject("content")))
            } }
        } finally { filler.delete(); capture?.let { File(it.getString("path")).delete() }; staged?.let { File(it.getString("path")).delete() } }
    }
    @Test fun retainedPhotoIsProtectedFromCleanupAndDeletionRequiresConfirmation() {
        val owner = "fixture:service:profile:generation:device"
        TransferStore(context).use { transfers -> LocalStore(context).use { store ->
            val photos = PhotoStore(context, transfers)
            val record = photos.create(target(owner))
            val file = photos.file(record); image(file)
            file.setLastModified(System.currentTimeMillis() - LocalFiles.TEMPORARY_GRACE_MS - 60000)
            try {
                assertFalse(LocalFiles(context, transfers, store).temporary().any { it.file == file.canonicalFile })
                ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("fixture", true)).use {
                    MobileUiTestDriver.openFiles(); click("本机上传记录"); click(record.getJSONObject("file").getString("name"), false); click("删除本机照片"); click("保留")
                    assertTrue(file.exists())
                    MobileUiTestDriver.openFiles(); click("本机上传记录"); click(record.getJSONObject("file").getString("name"), false); click("删除本机照片"); click("删除")
                    waitFor { !file.exists() }
                    assertEquals("cancelled", photos.current(record).getString("state"))
                }
            } finally { file.delete() }
        } }
    }
    private fun click(value: String, exact: Boolean = true) = if (exact) MobileUiTestDriver.click(value) else MobileUiTestDriver.clickContaining(value)
    private fun waitFor(condition: () -> Boolean) { val deadline = SystemClock.uptimeMillis() + 10000; while (SystemClock.uptimeMillis() < deadline) { if (condition()) return; SystemClock.sleep(50) }; if (!condition()) MobileUiTestDriver.fail("Photo recovery did not reach expected state") }
}
