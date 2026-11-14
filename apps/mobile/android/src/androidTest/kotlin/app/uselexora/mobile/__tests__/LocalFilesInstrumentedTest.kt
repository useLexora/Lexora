package app.uselexora.mobile

import app.uselexora.mobile.protocol.MobileContentAdapter
import android.content.Intent
import android.system.Os
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.storage.*
import app.uselexora.mobile.ui.MainActivity
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

@RunWith(AndroidJUnit4::class)
class LocalFilesInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun record(partition: String, kind: String, state: String): JSONObject {
        val id = UUID.randomUUID().toString()
        val directory = File(context.filesDir, if (kind == "download") "exports" else "staging").apply { mkdirs() }
        val file = File(directory, if (kind == "download") "$id-notes.txt" else id).apply { writeText("手机副本中文😀") }
        return JSONObject().put("id", id).put("partition", partition).put("kind", kind).put("state", state).put("path", file.absolutePath)
            .put(if (kind == "download") "prepared" else "file", JSONObject().put("name", "清理验证-$id.txt").put("mimeType", "text/plain"))
    }
    @Test fun cleanupProtectsPendingWorkAndRejectsStaleRecordsOrPathsOutsideItsOwnedDirectory() {
        val partition = "cleanup-${UUID.randomUUID()}"
        LocalStore(context).use { store -> TransferStore(context).use { transfers ->
            val download = record(partition, "download", "ready")
            val pending = record(partition, "upload", "receiving")
            val adopted = record(partition, "upload", "adopted")
            val outside = File(context.filesDir, "outside-${UUID.randomUUID()}").apply { writeText("保留") }
            val link = File(File(context.filesDir, "exports"), "${UUID.randomUUID()}-linked.txt")
            try {
                for (entry in listOf(download, pending, adopted)) transfers.save(entry)
                store.edit(partition, "global", JSONObject().put("content", MobileContentAdapter.textContent("保留未发输入")))
                store.queue(partition, "uploads.adopt", JSONObject().put("commandId", UUID.randomUUID().toString()), JSONObject().put("transferId", adopted.getString("id")))
                val files = LocalFiles(context, transfers, store)
                val entries = files.list().filter { it.record.getString("partition") == partition }
                assertEquals(3, entries.size)
                assertTrue(entries.single { it.download }.removable)
                assertFalse(entries.first { it.record.getString("id") == pending.getString("id") }.removable)
                assertFalse(entries.first { it.record.getString("id") == adopted.getString("id") }.removable)
                assertTrue(runCatching { files.remove(pending) }.isFailure); assertTrue(File(pending.getString("path")).exists())
                val changed = JSONObject(download.toString()).put("state", "receiving"); transfers.save(changed)
                assertTrue(runCatching { files.remove(download) }.isFailure); assertTrue(File(download.getString("path")).exists())
                transfers.save(JSONObject(download.toString()).put("path", outside.absolutePath))
                assertFalse(files.list().any { it.record.getString("id") == download.getString("id") })
                Os.symlink(outside.absolutePath, link.absolutePath)
                transfers.save(JSONObject(download.toString()).put("path", link.absolutePath))
                assertFalse(files.list().any { it.record.getString("id") == download.getString("id") })
                transfers.save(download); files.remove(download)
                assertFalse(File(download.getString("path")).exists())
                assertEquals("保留", outside.readText())
                assertEquals("保留未发输入", MobileContentAdapter.text(store.draft(partition, "global")!!.value.getJSONObject("content")))
                assertEquals(1, store.outbox(partition).size)
            } finally { for (entry in listOf(download, pending, adopted)) File(entry.getString("path")).delete(); link.delete(); outside.delete() }
        } }
    }
    @Test fun unwritableStagingIsReportedAsLocalFailureAndDoesNotEraseInput() {
        val partition = "storage-failure-${UUID.randomUUID()}"
        val source = File(File(context.filesDir, "exports").apply { mkdirs() }, "${UUID.randomUUID()}.txt").apply { writeText("attachment") }
        val staging = File(context.filesDir, "staging").apply { mkdirs() }
        val previousMode = Os.stat(staging.absolutePath).st_mode and 511
        LocalStore(context).use { store -> TransferStore(context).use { transfers ->
            val schemas = app.uselexora.mobile.protocol.ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
            val files = app.uselexora.mobile.network.MobileFiles(context, transfers, store, app.uselexora.mobile.network.MobileConnection(context, schemas, BuildConfig.VERSION_NAME))
            store.edit(partition, "global", JSONObject().put("content", MobileContentAdapter.textContent("保留输入")))
            try {
                Os.chmod(staging.absolutePath, 365)
                val uri = androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.files", source)
                val failure = runCatching { files.stage(uri, partition, "global", JSONObject().put("kind", "global")) }.exceptionOrNull()
                assertEquals("LOCAL_FILE_FAILED", (failure as? app.uselexora.mobile.protocol.ProtocolFailure)?.code)
                assertTrue(transfers.list(partition).isEmpty())
                assertEquals("保留输入", MobileContentAdapter.text(store.draft(partition, "global")!!.value.getJSONObject("content")))
            } finally { Os.chmod(staging.absolutePath, previousMode); source.delete() }
        } }
    }
    @Test fun offlineCopiesRequireExplicitConfirmationBeforeRemoval() {
        val partition = "offline-${UUID.randomUUID()}"
        TransferStore(context).use { transfers ->
            val download = record(partition, "download", "ready")
            val file = File(download.getString("path"))
            transfers.save(download)
            try { ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("fixture", true)).use {
                openLocalFiles()
                val name = download.getJSONObject("prepared").getString("name")
                if (InstrumentationRegistry.getArguments().getString("captureScreenshots") == "true") {
                    val instrumentation = InstrumentationRegistry.getInstrumentation()
                    instrumentation.uiAutomation.waitForIdle(300, 5000)
                    instrumentation.uiAutomation.takeScreenshot()?.let { bitmap -> File(context.externalCacheDir, "local-files.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
                }
                click(name, exact = false); click("清理手机副本"); click("取消")
                assertTrue(file.exists())
                openLocalFiles(); click(name, exact = false); click("清理手机副本"); click("清理")
                waitFor { !file.exists() }
                assertEquals("cleared", transfers.list(partition).single().getString("state"))
            } } finally { file.delete() }
        }
    }
    @Test fun fullQuotaRefusesNewCopiesWithoutDeletingInputCommandsOrExistingFiles() {
        val partition = "quota-${UUID.randomUUID()}"
        val source = File(File(context.filesDir, "exports").apply { mkdirs() }, "${UUID.randomUUID()}.txt").apply { writeText("新附件") }
        val staging = File(context.filesDir, "staging").apply { mkdirs() }
        val filler = File(staging, UUID.randomUUID().toString())
        LocalStore(context).use { store -> TransferStore(context).use { transfers ->
            val schemas = app.uselexora.mobile.protocol.ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() }))
            val files = app.uselexora.mobile.network.MobileFiles(context, transfers, store, app.uselexora.mobile.network.MobileConnection(context, schemas, BuildConfig.VERSION_NAME))
            store.edit(partition, "global", JSONObject().put("content", MobileContentAdapter.textContent("仍然保留😀")))
            val pending = store.queue(partition, "chat.startTurn", JSONObject().put("commandId", store.newId()))
            try {
                java.io.RandomAccessFile(filler, "rw").use { it.setLength(FileBudget(context.filesDir).capacity().remaining) }
                val before = staging.list()!!.toSet()
                val uri = androidx.core.content.FileProvider.getUriForFile(context, "${context.packageName}.files", source)
                val failure = runCatching { files.stage(uri, partition, "global", JSONObject().put("kind", "global")) }.exceptionOrNull()
                assertEquals("LOCAL_CACHE_FULL", (failure as? app.uselexora.mobile.protocol.ProtocolFailure)?.code)
                assertEquals(before, staging.list()!!.toSet())
                assertEquals(FileBudget.MAX_BYTES, FileBudget(context.filesDir).capacity().used)
                assertTrue(transfers.list(partition).isEmpty())
                assertEquals("仍然保留😀", MobileContentAdapter.text(store.draft(partition, "global")!!.value.getJSONObject("content")))
                assertEquals(pending.id, store.outbox(partition).single().id)
            } finally { filler.delete(); source.delete() }
        } }
    }
    @Test fun orphanCleanupRechecksAgeReferencesAndActiveFilesBeforeDeleting() {
        val partition = "orphan-${UUID.randomUUID()}"
        val created = mutableListOf<File>()
        val old = System.currentTimeMillis() - LocalFiles.TEMPORARY_GRACE_MS - 60000
        fun temp(directory: String, suffix: String, aged: Boolean = true): File {
            val parent = if (directory == "cache") context.cacheDir else File(context.filesDir, directory).apply { mkdirs() }
            val name = if (directory == "cache") "preview-${UUID.randomUUID()}.pixels" else "${UUID.randomUUID()}$suffix"
            return File(parent, name).apply { writeText("保留或清理"); if (aged) assertTrue(setLastModified(old)); created.add(this) }
        }
        LocalStore(context).use { store -> TransferStore(context).use { transfers ->
            val orphan = temp("exports", ".part")
            val preview = temp("cache", ".pixels")
            val active = temp("capture", ".jpg")
            val fresh = temp("staging", ".part", false)
            val changed = temp("staging", ".part")
            val adoptedLater = temp("staging", "")
            val pending = record(partition, "upload", "receiving").also { transfers.save(it) }
            created.add(File(pending.getString("path")).apply { setLastModified(old) })
            try {
                store.edit(partition, "global", JSONObject().put("content", MobileContentAdapter.textContent("待发")))
                store.queue(partition, "uploads.adopt", JSONObject().put("commandId", store.newId()))
                val files = LocalFiles(context, transfers, store) { setOf(active.absolutePath) }
                val candidates = files.temporary().filter { it.file in created.map { f -> f.canonicalFile } }
                assertEquals(setOf(orphan.canonicalFile, preview.canonicalFile, changed.canonicalFile, adoptedLater.canonicalFile), candidates.map { it.file }.toSet())
                changed.appendText("已变化")
                transfers.save(JSONObject().put("id", adoptedLater.name).put("partition", partition).put("kind", "upload").put("state", "staged").put("path", adoptedLater.absolutePath))
                assertEquals(2, files.removeTemporary(candidates))
                assertFalse(orphan.exists()); assertFalse(preview.exists())
                for (file in listOf(active, fresh, changed, adoptedLater, File(pending.getString("path")))) assertTrue(file.exists())
                assertEquals("待发", MobileContentAdapter.text(store.draft(partition, "global")!!.value.getJSONObject("content")))
                assertEquals(1, store.outbox(partition).size)
            } finally { created.forEach { it.delete() } }
        } }
    }
    @Test fun interruptedDownloadsCanBeClearedButCannotBeSharedAsCompleteFiles() {
        val partition = "partial-${UUID.randomUUID()}"
        val id = UUID.randomUUID().toString()
        val partial = File(File(context.filesDir, "exports").apply { mkdirs() }, "$id.part").apply { writeText("partial") }
        LocalStore(context).use { store -> TransferStore(context).use { transfers ->
            val record = JSONObject().put("id", id).put("partition", partition).put("kind", "download").put("state", "receiving").put("confirmedBytes", partial.length())
                .put("prepared", JSONObject().put("name", "未完成-$id.txt").put("mimeType", "text/plain"))
            transfers.save(record)
            try {
                val files = LocalFiles(context, transfers, store)
                val entry = files.list().single { it.record.getString("id") == id }
                assertFalse(entry.complete); assertTrue(entry.removable)
                ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("fixture", true)).use {
                    openLocalFiles(); click("未完成-$id.txt", exact = false)
                    assertFalse(MobileUiTestDriver.contains("分享文件"))
                    assertFalse(MobileUiTestDriver.contains("预览"))
                    click("清理手机副本"); click("清理")
                    waitFor { !partial.exists() }
                }
                val saved = transfers.list(partition).single()
                assertEquals("cleared", saved.getString("state")); assertEquals(0L, saved.getLong("confirmedBytes"))
                assertEquals(record.getJSONObject("prepared").toString(), saved.getJSONObject("prepared").toString())
            } finally { partial.delete() }
        } }
    }
    @Test fun temporaryCleanupRequiresConfirmationAndKeepsCancelledFiles() {
        val temporary = File(File(context.filesDir, "exports").apply { mkdirs() }, "${UUID.randomUUID()}.part").apply {
            writeText("遗留断点"); setLastModified(System.currentTimeMillis() - LocalFiles.TEMPORARY_GRACE_MS - 60000)
        }
        try { ActivityScenario.launch<MainActivity>(Intent(context, MainActivity::class.java).putExtra("fixture", true)).use {
            openLocalFiles(); click("清理临时文件")
            if (InstrumentationRegistry.getArguments().getString("captureScreenshots") == "true") {
                val instrumentation = InstrumentationRegistry.getInstrumentation()
                instrumentation.uiAutomation.waitForIdle(300, 5000)
                instrumentation.uiAutomation.takeScreenshot()?.let { bitmap -> File(context.externalCacheDir, "temporary-files.png").outputStream().use { bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }; bitmap.recycle() }
            }
            click("取消"); assertTrue(temporary.exists())
            openLocalFiles(); click("清理临时文件"); click("清理")
            waitFor { !temporary.exists() }
        } } finally { temporary.delete() }
    }
    private fun openLocalFiles() {
        MobileUiTestDriver.openFiles(); click("本机文件与清理")
    }
    private fun click(value: String, exact: Boolean = true) = if (exact) MobileUiTestDriver.click(value) else MobileUiTestDriver.clickContaining(value)
    private fun waitFor(condition: () -> Boolean) = MobileUiTestDriver.waitUntil(condition = condition)
}
