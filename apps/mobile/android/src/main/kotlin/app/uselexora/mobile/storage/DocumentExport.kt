package app.uselexora.mobile.storage

import android.content.Context
import android.net.Uri
import app.uselexora.mobile.protocol.ProtocolFailure
import java.io.File
import java.io.IOException
import java.nio.file.Files

class DocumentExport(private val context: Context) {
    fun save(source: File, destination: Uri): Unit = synchronized(TransferStore.fileLock) {
        try {
            if (destination.scheme != "content" || destination.authority == "${context.packageName}.files") throw ProtocolFailure("DOCUMENT_SAVE_FAILED")
            val directory = File(context.filesDir, "exports").canonicalFile
            if (Files.isSymbolicLink(source.toPath()) || source.canonicalFile.parentFile != directory || !source.isFile) throw ProtocolFailure("RESOURCE_UNAVAILABLE")
            source.inputStream().use { input ->
                context.contentResolver.openOutputStream(destination, "wt").use { output ->
                    if (output == null) throw ProtocolFailure("DOCUMENT_SAVE_FAILED")
                    input.copyTo(output)
                    output.flush()
                }
            }
        } catch (error: IOException) { throw ProtocolFailure("DOCUMENT_SAVE_FAILED", error) }
        catch (error: SecurityException) { throw ProtocolFailure("DOCUMENT_SAVE_FAILED", error) }
    }
}
