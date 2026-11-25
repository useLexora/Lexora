package app.uselexora.mobile.network

import android.os.Build
import android.provider.MediaStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.storage.TransferStore
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
@SdkSuppress(minSdkVersion = Build.VERSION_CODES.Q)
class ExplicitDownloadInstrumentedTest {
    private val context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val owner = "explicit-fixture-${UUID.randomUUID()}"
    private fun connection() = MobileConnection(context, ProtocolSchemas(JSONObject(context.assets.open("protocol-schema.json").bufferedReader().use { it.readText() })), "fixture")
    private fun await(dl: Downloads, id: String, state: DownloadState): DownloadRecord {
        val latch = CountDownLatch(1)
        dl.listen(owner) { rows -> if (rows.any { it.id == id && it.state == state }) latch.countDown() }.use {
            assertTrue("Wanted $state: ${dl.records(owner)}", latch.await(60, TimeUnit.SECONDS))
        }
        return dl.records(owner).single { it.id == id }
    }
    @Test fun strictPartitionOfflineExportPublishesVerifiedBytesAndNeverDeletesCompletedUri() {
        val bytes = "真实文件 🎨".repeat(1000).toByteArray(); val version = MobileFiles.hash(bytes)
        val resource = JSONObject().put("resourceId", "fixture").put("revision", "r1").put("name", "fixture.txt").put("mimeType", "text/plain")
        val metadata = JSONObject().put("sizeBytes", bytes.size.toString()).put("contentVersion", version).put("name", "fixture.txt").put("mimeType", "text/plain")
        val key = UUID.randomUUID().toString(); val file = File(File(context.filesDir, "exports").apply { mkdirs() }, "$key-fixture.txt").apply { writeBytes(bytes) }
        val transfer = JSONObject().put("kind", "download").put("partition", owner).put("id", key).put("state", "ready").put("prepared", metadata)
            .put("resourceId", "fixture").put("expectedVersion", "r1").put("contentVersion", version).put("path", file.absolutePath)
        val dl = Downloads.get(context); val connection = connection()
        var uri: android.net.Uri? = null
        try {
            val id = dl.start(owner, resource, null, connection)
            assertEquals("NOT_CONNECTED", await(dl, id, DownloadState.INTERRUPTED).error)
            assertTrue(dl.records("other-$owner").isEmpty()); assertTrue(runCatching { dl.resume("other-$owner", id, null, connection) }.isFailure)
            TransferStore(context).use { it.save(transfer) }
            dl.resume(owner, id, null, connection)
            val done = await(dl, id, DownloadState.COMPLETED); uri = done.uri!!
            assertEquals(version, done.contentVersion); assertEquals(bytes.size.toLong(), done.bytes)
            dl.cancel(owner, id); assertEquals(DownloadState.COMPLETED, dl.records(owner).single { it.id == id }.state)
            assertArrayEquals(bytes, context.contentResolver.openInputStream(uri)!!.use { it.readBytes() })
            context.contentResolver.query(uri, arrayOf(MediaStore.MediaColumns.IS_PENDING, MediaStore.MediaColumns.RELATIVE_PATH), null, null, null)!!.use {
                assertTrue(it.moveToFirst()); assertEquals(0, it.getInt(0)); assertEquals("Download/Lexora/", it.getString(1))
            }
        } finally { uri?.let { context.contentResolver.delete(it, null, null) }; file.delete() }
    }
    @Test fun gibibyteCheckpointCanPauseDuringVerificationAndResumeWithoutNetworkOrPrivateCopy() {
        val prefix = 1024L * 1024 * 1024; val tail = "lexora-tail".toByteArray(); val size = prefix + tail.size
        val id = UUID.randomUUID().toString()
        val row = DownloadEntry(DownloadRecord(id, owner, "large", "r1", "large.iso", "application/octet-stream", DownloadState.RUNNING, size, size,
            "a4d177e1af51c9796da053682205e0434f58dbfcd2b66b8e477bc88a6c8601b8", null, null))
        val destination = DownloadDestination(context); val pending = destination.pending(row, true)!!
        try {
            destination.writer(pending).use { it.channel.position(prefix); it.write(tail); it.fd.sync() }
            DownloadJournal(context).use { it.save(row.copy(pending = pending)) }
            val dl = Downloads(context); val connection = connection()
            dl.listen(owner) { records -> if (records.any { it.id == id && it.state == DownloadState.VERIFYING }) dl.pause(owner, id) }.use {
                dl.resume(owner, id, null, connection)
                val paused = await(dl, id, DownloadState.PAUSED); assertNull(paused.uri); assertEquals(size, paused.bytes)
            }
            dl.resume(owner, id, null, connection)
            val done = await(dl, id, DownloadState.COMPLETED); assertEquals(size, done.bytes)
            context.contentResolver.openFileDescriptor(done.uri!!, "r")!!.use { assertEquals(size, it.statSize) }
        } finally { context.contentResolver.delete(pending, null, null) }
    }
    @Test fun missingSafDocumentNeverAdoptsOrDeletesAnotherDocumentOfTheSameName() {
        val id = UUID.randomUUID().toString(); val tree = android.provider.DocumentsContract.buildTreeDocumentUri("fixture.test", "dir")
        val old = android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, "gone")
        val other = android.provider.DocumentsContract.buildDocumentUriUsingTree(tree, "user-file")
        var userFileExists = true
        val provider = object : android.content.ContentProvider() {
            override fun onCreate() = true
            override fun getType(uri: android.net.Uri) = "application/octet-stream"
            override fun insert(uri: android.net.Uri, values: android.content.ContentValues?) = throw UnsupportedOperationException()
            override fun update(uri: android.net.Uri, values: android.content.ContentValues?, selection: String?, selectionArgs: Array<out String>?) = throw UnsupportedOperationException()
            override fun delete(uri: android.net.Uri, selection: String?, selectionArgs: Array<out String>?): Int { if (uri == other) userFileExists = false; return 1 }
            override fun query(uri: android.net.Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): android.database.Cursor {
                val columns = projection ?: error("missing projection")
                return android.database.MatrixCursor(columns).apply { when {
                    uri == old -> Unit
                    uri.lastPathSegment == "children" -> addRow(arrayOf("user-file", "lexora-$id.bin", "application/octet-stream"))
                    uri == other -> addRow(arrayOf("lexora-$id.bin"))
                    else -> addRow(arrayOf("Lexora"))
                } }
            }
        }
        provider.attachInfo(context, android.content.pm.ProviderInfo().apply { authority = "fixture.test"; exported = false })
        val resolver = android.content.ContentResolver.wrap(provider)
        val destination = DownloadDestination(object : android.content.ContextWrapper(context) { override fun getContentResolver() = resolver })
        val row = DownloadEntry(DownloadRecord(id, owner, "r", "v", "notes.txt", "text/plain", DownloadState.INTERRUPTED, 10L, 20L, null, null, null), tree, pending = old)
        assertNull(destination.pending(row, false)); assertTrue(runCatching { destination.pending(row, true) }.isFailure)
        destination.discard(row); destination.discard(row.copy(pending = null)); assertTrue(userFileExists)
        assertTrue(runCatching { destination.published(row.copy(publishing = "notes.txt")) }.isFailure)
    }
    @Test fun reconstructsInterruptedDurablePrefixAndCancellationRemovesUnpublishedSystemRow() {
        val bytes = ByteArray(128) { it.toByte() }; val id = UUID.randomUUID().toString()
        val row = DownloadEntry(DownloadRecord(id, owner, "resource", "r1", "notes.txt", "text/plain", DownloadState.RUNNING, 64, 128, MobileFiles.hash(bytes), null, null))
        val destination = DownloadDestination(context)
        val temp = destination.pending(row, true)!!
        try {
            destination.writer(temp).use { it.write(bytes, 0, 96); it.fd.sync() }
            DownloadJournal(context).use { it.save(row.copy(pending = temp)) }
            val dl = Downloads(context)
            val recovered = dl.records(owner).single { it.id == id }; assertEquals(64L, recovered.bytes); assertEquals(DownloadState.INTERRUPTED, recovered.state); assertNull(recovered.uri)
            dl.cancel(owner, id); val done = await(dl, id, DownloadState.CANCELLED); assertEquals(0L, done.bytes)
            assertNull(destination.pending(row, false))
        } finally { context.contentResolver.delete(temp, null, null) }
    }
}
