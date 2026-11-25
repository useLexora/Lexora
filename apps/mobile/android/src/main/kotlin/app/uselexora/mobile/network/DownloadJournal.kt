package app.uselexora.mobile.network

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.net.Uri
import org.json.JSONObject

enum class DownloadState { QUEUED, RUNNING, VERIFYING, PAUSED, INTERRUPTED, FAILED, COMPLETED, CANCELLED }

data class DownloadRecord(
    val id: String, val partition: String, val resourceId: String, val revision: String,
    val name: String, val mimeType: String, val state: DownloadState,
    val bytes: Long, val totalBytes: Long?, val contentVersion: String?, val uri: Uri?, val error: String?, val customFolder: Boolean = false,
)

internal data class DownloadEntry(
    val record: DownloadRecord, val tree: Uri? = null, val pending: Uri? = null,
    val publishing: String? = null, val deleting: Boolean = false, val downloadId: String? = null, val expiresAt: String? = null,
) {
    fun encode() = with(record) { JSONObject().put("id", id).put("partition", partition).put("resourceId", resourceId)
        .put("revision", revision).put("name", name).put("mimeType", mimeType).put("state", state.name)
        .put("bytes", bytes).put("totalBytes", totalBytes).put("hash", contentVersion).put("uri", uri?.toString())
        .put("error", error).put("tree", tree?.toString()).put("pending", pending?.toString())
        .put("publishing", publishing).put("deleting", deleting).put("downloadId", downloadId).put("expiresAt", expiresAt).toString() }

    companion object {
        fun decode(json: JSONObject): DownloadEntry = with(json) {
            fun optional(key: String) = if (isNull(key)) null else getString(key)
            fun uri(key: String) = optional(key)?.let(Uri::parse)
            DownloadEntry(DownloadRecord(getString("id"), getString("partition"), getString("resourceId"), getString("revision"),
                getString("name"), getString("mimeType"), DownloadState.valueOf(getString("state")), getLong("bytes"),
                if (isNull("totalBytes")) null else getLong("totalBytes"), optional("hash"), uri("uri"), optional("error"), !isNull("tree")),
                uri("tree"), uri("pending"), optional("publishing"), optBoolean("deleting"), optional("downloadId"), optional("expiresAt"))
        }
    }
}

internal class DownloadJournal(context: Context) : SQLiteOpenHelper(context, "explicit-downloads.db", null, 1) {
    override fun onConfigure(db: SQLiteDatabase) { db.execSQL("PRAGMA synchronous=FULL") }
    override fun onCreate(db: SQLiteDatabase) { db.execSQL("CREATE TABLE jobs(id TEXT PRIMARY KEY, body TEXT NOT NULL)") }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) = error("UNSUPPORTED_STORAGE_VERSION")
    fun load() = readableDatabase.rawQuery("SELECT body FROM jobs ORDER BY rowid", null).use { cursor ->
        buildList { while (cursor.moveToNext()) add(DownloadEntry.decode(JSONObject(cursor.getString(0)))) }
    }
    fun save(entry: DownloadEntry) {
        val values = ContentValues().apply { put("id", entry.record.id); put("body", entry.encode()) }
        if (writableDatabase.update("jobs", values, "id=?", arrayOf(entry.record.id)) == 0) writableDatabase.insertOrThrow("jobs", null, values)
    }
}
