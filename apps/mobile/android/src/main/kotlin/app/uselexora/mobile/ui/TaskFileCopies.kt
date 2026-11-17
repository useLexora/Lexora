package app.uselexora.mobile.ui

import android.content.Context
import app.uselexora.mobile.network.MobileFiles
import app.uselexora.mobile.protocol.ProtocolFailure
import app.uselexora.mobile.storage.LocalFiles
import app.uselexora.mobile.storage.LocalStore
import app.uselexora.mobile.storage.TransferStore
import org.json.JSONObject
import java.io.File
import java.io.IOException

internal class TaskFileCopies(context: Context, transfers: TransferStore, store: LocalStore) {
    private val files = LocalFiles(context, transfers, store)
    fun find(partition: String, resource: JSONObject): File? = synchronized(TransferStore.fileLock) {
        val entry = files.list().firstOrNull {
            it.complete && it.record.optString("partition") == partition &&
                it.record.optString("resourceId") == resource.getString("resourceId") &&
                it.record.optString("expectedVersion") == resource.getString("revision")
        } ?: return@synchronized null
        try {
            val metadata = entry.record.getJSONObject("prepared")
            val size = metadata.getString("sizeBytes").toLong()
            if (size !in 0..MobileFiles.MAX_BYTES || entry.file.length() != size) return@synchronized null
            entry.file.takeIf { MobileFiles.hash(it) == entry.record.getString("contentVersion") }
        } catch (error: IOException) { throw ProtocolFailure("LOCAL_STORAGE_FAILED", error) }
        catch (error: SecurityException) { throw ProtocolFailure("LOCAL_STORAGE_FAILED", error) }
    }
    fun confirmed(partition: String, resources: List<JSONObject>): Set<String> = resources.mapNotNull { resource ->
        runCatching { find(partition, resource) }.getOrNull()?.let { resource.getString("resourceId") }
    }.toSet()
}
