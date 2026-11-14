package app.uselexora.mobile.storage

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import android.content.Context
import app.uselexora.mobile.protocol.ProtocolFailure
import org.json.JSONObject
import java.io.File
import java.nio.file.Files
import java.util.UUID

class PhotoStore(private val context: Context, private val transfers: TransferStore) {
    fun create(target: JSONObject): JSONObject = synchronized(TransferStore.fileLock) {
        val directory = File(context.filesDir, "capture").apply { mkdirs() }
        if (!directory.isDirectory) throw ProtocolFailure("LOCAL_STORAGE_FAILED")
        val id = UUID.randomUUID().toString()
        JSONObject(target.toString()).put("id", id).put("kind", "capture").put("state", "captured").put("path", File(directory, "$id.jpg").absolutePath)
            .put("file", JSONObject().put("name", mobileText(R.string.mobile_photo_jpg, id)).put("mimeType", "image/jpeg")).also { transfers.save(it) }
    }
    fun current(original: JSONObject): JSONObject = transfers.list(original.getString("partition")).firstOrNull { it.optString("kind") == "capture" && it.getString("id") == original.getString("id") } ?: throw ProtocolFailure("RESOURCE_UNAVAILABLE")
    fun file(record: JSONObject): File {
        val directory = File(context.filesDir, "capture").canonicalFile
        val file = File(record.getString("path"))
        if (Files.isSymbolicLink(file.toPath()) || file.canonicalFile.parentFile != directory || file.name != "${record.getString("id")}.jpg") throw ProtocolFailure("RESOURCE_UNAVAILABLE")
        return file
    }
    fun discard(original: JSONObject): Unit = synchronized(TransferStore.fileLock) {
        val record = current(original)
        val file = file(record)
        if (file.exists() && !file.delete()) throw ProtocolFailure("LOCAL_STORAGE_FAILED")
        record.put("state", "cancelled"); transfers.save(record)
    }
    fun copied(record: JSONObject, transfer: JSONObject) {
        val file = file(record)
        if (file.exists() && !file.delete()) throw ProtocolFailure("LOCAL_STORAGE_FAILED")
        record.put("state", "copied").put("transferId", transfer.getString("id")); transfers.save(record)
    }
}
