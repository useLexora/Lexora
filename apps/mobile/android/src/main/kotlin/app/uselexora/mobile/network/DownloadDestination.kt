package app.uselexora.mobile.network

import android.annotation.TargetApi
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract as Docs
import android.provider.MediaStore
import android.provider.OpenableColumns
import app.uselexora.mobile.protocol.ProtocolFailure
import java.io.FileNotFoundException

internal class DownloadDestination(private val context: Context) {
    private val resolver get() = context.contentResolver
    private val directory = "${Environment.DIRECTORY_DOWNLOADS}/Lexora/"
    private fun temporary(entry: DownloadEntry) = "lexora-${entry.record.id}.bin"
    private fun missing(): Nothing = throw ProtocolFailure("LOCAL_STORAGE_FAILED")

    fun grant(tree: Uri?) {
        if (tree == null) {
            if (Build.VERSION.SDK_INT < 29) throw ProtocolFailure("DOWNLOAD_DIRECTORY_REQUIRED")
        } else {
            if (tree.scheme != "content" || !Docs.isTreeUri(tree)) throw ProtocolFailure("DOWNLOAD_DIRECTORY_REQUIRED")
            resolver.takePersistableUriPermission(tree, Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION)
        }
    }

    private fun name(uri: Uri): String? = resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
        if (it.moveToFirst()) it.getString(0) else null
    }
    private fun child(parent: Uri, wanted: String, directory: Boolean = false): Uri? {
        val children = Docs.buildChildDocumentsUriUsingTree(parent, Docs.getDocumentId(parent))
        return resolver.query(children, arrayOf(Docs.Document.COLUMN_DOCUMENT_ID, Docs.Document.COLUMN_DISPLAY_NAME, Docs.Document.COLUMN_MIME_TYPE), null, null, null)?.use { cursor ->
            while (cursor.moveToNext()) if (cursor.getString(1) == wanted && (!directory || cursor.getString(2) == Docs.Document.MIME_TYPE_DIR)) {
                return@use Docs.buildDocumentUriUsingTree(parent, cursor.getString(0))
            }
            null
        }
    }
    private fun folder(tree: Uri, create: Boolean): Uri? {
        val parent = Docs.buildDocumentUriUsingTree(tree, Docs.getTreeDocumentId(tree))
        if (name(parent) == "Lexora") return parent
        return child(parent, "Lexora", true) ?: if (create) Docs.createDocument(resolver, parent, Docs.Document.MIME_TYPE_DIR, "Lexora") ?: missing() else null
    }
    @TargetApi(29)
    private fun newMedia(entry: DownloadEntry): Uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, temporary(entry)); put(MediaStore.MediaColumns.MIME_TYPE, "application/octet-stream")
        put(MediaStore.MediaColumns.RELATIVE_PATH, directory); put(MediaStore.MediaColumns.IS_PENDING, 1)
    }) ?: missing()

    fun pending(entry: DownloadEntry, create: Boolean): Uri? {
        if (entry.pending != null) {
            if (entry.tree == null && Build.VERSION.SDK_INT >= 29) {
                if (isMediaPending(entry.pending) == true) return entry.pending
            } else if (name(entry.pending) == temporary(entry)) return entry.pending
            if (create) throw ProtocolFailure("SOURCE_CHANGED")
            return null
        }
        if (!create) return null
        val tree = entry.tree
        return if (tree == null && Build.VERSION.SDK_INT >= 29) newMedia(entry)
        else {
            val parent = folder(tree ?: missing(), true) ?: missing()
            if (child(parent, temporary(entry)) != null) throw ProtocolFailure("SOURCE_CHANGED")
            Docs.createDocument(resolver, parent, "application/octet-stream", temporary(entry)) ?: missing()
        }
    }
    fun writer(uri: Uri) = ParcelFileDescriptor.AutoCloseOutputStream(resolver.openFileDescriptor(uri, "rw") ?: missing())
    fun reader(uri: Uri) = resolver.openInputStream(uri) ?: throw FileNotFoundException()

    fun publishName(entry: DownloadEntry): String {
        if (entry.tree == null) return entry.record.name
        val parent = folder(entry.tree, false) ?: missing()
        val name = entry.record.name
        if (child(parent, name) == null) return name
        val dot = name.lastIndexOf('.').takeIf { it > 0 } ?: name.length
        return name.substring(0, dot) + "-${entry.record.id}" + name.substring(dot)
    }
    @TargetApi(29)
    private fun isMediaPending(uri: Uri): Boolean? = resolver.query(uri, arrayOf(MediaStore.MediaColumns.IS_PENDING), null, null, null)?.use {
        if (it.moveToFirst()) it.getInt(0) != 0 else null
    }
    fun published(entry: DownloadEntry): Uri? {
        val finalName = entry.publishing ?: return null
        val uri = entry.pending ?: return null
        if (entry.tree == null && Build.VERSION.SDK_INT >= 29) return uri.takeIf { isMediaPending(it) == false }
        return when (name(uri)) {
            temporary(entry) -> null
            finalName -> uri
            else -> throw ProtocolFailure("DOWNLOAD_PUBLISH_UNCERTAIN")
        }
    }
    fun publish(entry: DownloadEntry): Uri {
        val uri = entry.pending ?: missing()
        val name = entry.publishing ?: missing()
        if (entry.tree != null) return Docs.renameDocument(resolver, uri, name) ?: missing()
        if (Build.VERSION.SDK_INT < 29) missing()
        val updated = resolver.update(uri, ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name); put(MediaStore.MediaColumns.MIME_TYPE, entry.record.mimeType)
            put(MediaStore.MediaColumns.IS_PENDING, 0)
        }, "is_pending=1", null)
        if (updated != 1) missing()
        return uri
    }
    fun discard(entry: DownloadEntry) {
        val uri = pending(entry, false) ?: return
        val deleted = if (entry.tree != null) Docs.deleteDocument(resolver, uri) else resolver.delete(uri, "is_pending=1", null) == 1
        if (!deleted) missing()
    }
}
