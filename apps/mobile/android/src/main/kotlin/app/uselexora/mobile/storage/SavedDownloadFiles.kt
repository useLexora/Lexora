package app.uselexora.mobile.storage

import android.content.Context
import android.net.Uri
import android.system.Os
import app.uselexora.mobile.network.DownloadRecord
import app.uselexora.mobile.network.DownloadState
import app.uselexora.mobile.network.MobileFiles
import app.uselexora.mobile.preview.PreviewPolicy
import app.uselexora.mobile.protocol.ProtocolFailure
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID

internal class SavedDownloadFiles(private val context: Context, private val transfers: TransferStore, store: LocalStore) {
    private val local = LocalFiles(context, transfers, store)

    fun preview(record: DownloadRecord): File = synchronized(TransferStore.fileLock) {
        val source = source(record)
        val size = record.totalBytes ?: throw ProtocolFailure("RESOURCE_UNAVAILABLE")
        if (size !in 0..PreviewPolicy.MAX_FILE_BYTES) throw ProtocolFailure("FILE_TOO_LARGE")
        val directory = File(context.filesDir, "exports").apply { mkdirs() }
        if (Files.isSymbolicLink(directory.toPath()) || directory.canonicalFile.parentFile != context.filesDir.canonicalFile) throw ProtocolFailure("LOCAL_STORAGE_FAILED")
        val id = UUID.randomUUID().toString()
        val name = LocalFiles.downloadName(record.name)
        val file = File(directory, "$id-$name")
        val partial = File(directory, "$id.part")
        val metadata = JSONObject().put("name", record.name).put("sizeBytes", size.toString()).put("mimeType", record.mimeType).put("contentVersion", record.contentVersion)
        val entry = JSONObject().put("id", id).put("partition", record.partition).put("kind", "download")
            .put("resourceId", record.resourceId).put("expectedVersion", record.revision).put("contentVersion", record.contentVersion)
            .put("copyPurpose", "preview").put("prepared", metadata).put("path", file.absolutePath)
        local.reserve(size, entry)
        if (!partial.createNewFile()) throw ProtocolFailure("LOCAL_STORAGE_FAILED")
        try {
            readSource(source) { input -> FileOutputStream(partial).use { output -> copyVerified(input, output, record); output.fd.sync() } }
            if (!partial.renameTo(file)) throw ProtocolFailure("LOCAL_STORAGE_FAILED")
            transfers.save(entry.put("state", "ready").put("confirmedBytes", size))
            file
        } catch (error: Exception) {
            partial.delete(); file.delete(); throw error
        }
    }

    fun verify(record: DownloadRecord): Uri = source(record).also { uri -> readSource(uri) { copyVerified(it, null, record) } }

    fun export(record: DownloadRecord, destination: Uri) {
        val source = verify(record)
        val resolver = context.contentResolver
        if (source == destination || destination.scheme != "content" || destination.authority == "${context.packageName}.files") throw ProtocolFailure("DOCUMENT_SAVE_FAILED")
        resolver.openFileDescriptor(source, "r")?.use { src ->
            val from = Os.fstat(src.fileDescriptor)
            resolver.openFileDescriptor(destination, "rw")?.use { dst ->
                val to = Os.fstat(dst.fileDescriptor)
                if (from.st_dev == to.st_dev && from.st_ino == to.st_ino || dst.statSize != 0L) throw ProtocolFailure("DOWNLOAD_EMPTY_DESTINATION_REQUIRED")
                val channel = android.os.ParcelFileDescriptor.AutoCloseOutputStream(dst)
                channel.use { output ->
                    try {
                        android.os.ParcelFileDescriptor.AutoCloseInputStream(src).use { copyVerified(it, output, record) }
                        output.flush(); output.fd.sync()
                    } catch (failure: Exception) {
                        runCatching { output.channel.truncate(0); output.fd.sync() }; throw failure
                    }
                }
            } ?: throw ProtocolFailure("DOCUMENT_SAVE_FAILED")
        } ?: throw ProtocolFailure("RESOURCE_UNAVAILABLE")
    }

    private fun source(record: DownloadRecord): Uri = record.uri?.takeIf { record.state == DownloadState.COMPLETED &&
        it.scheme == "content" && it.authority != "${context.packageName}.files" && !record.contentVersion.isNullOrBlank() }
        ?: throw ProtocolFailure("RESOURCE_UNAVAILABLE")

    private fun <T> readSource(uri: Uri, block: (InputStream) -> T): T = try {
        context.contentResolver.openInputStream(uri)?.use(block) ?: throw ProtocolFailure("RESOURCE_UNAVAILABLE")
    } catch (error: java.io.FileNotFoundException) { throw ProtocolFailure("RESOURCE_UNAVAILABLE", error) }
      catch (error: SecurityException) { throw ProtocolFailure("RESOURCE_UNAVAILABLE", error) }

    private fun copyVerified(input: InputStream, output: OutputStream?, record: DownloadRecord) {
        val expected = record.totalBytes ?: throw ProtocolFailure("RESOURCE_UNAVAILABLE")
        val digest = MessageDigest.getInstance("SHA-256")
        val block = ByteArray(128 * 1024)
        var size = 0L
        while (true) {
            val read = input.read(block)
            if (read < 0) break
            size += read
            if (size > expected) throw ProtocolFailure("SOURCE_CHANGED")
            digest.update(block, 0, read); output?.write(block, 0, read)
        }
        if (size != expected || MobileFiles.hex(digest.digest()) != record.contentVersion) throw ProtocolFailure("SOURCE_CHANGED")
    }
}
