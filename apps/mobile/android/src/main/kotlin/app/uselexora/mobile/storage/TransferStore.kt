package app.uselexora.mobile.storage

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject

class TransferStore(context: Context) : SQLiteOpenHelper(context, "lexora-transfers.db", null, 1) {
    companion object { val fileLock = Any() }
    @Synchronized fun all(): List<JSONObject> = readableDatabase.rawQuery("SELECT record FROM transfers ORDER BY rowid DESC", null).use { cursor -> buildList { while (cursor.moveToNext()) add(JSONObject(cursor.getString(0))) } }
    override fun onConfigure(db: SQLiteDatabase) { db.execSQL("PRAGMA synchronous=FULL") }
    override fun onCreate(db: SQLiteDatabase) { db.execSQL("CREATE TABLE transfers(id TEXT PRIMARY KEY, partition TEXT NOT NULL, record TEXT NOT NULL)") }
    override fun onUpgrade(db: SQLiteDatabase, old: Int, new: Int) { error("UNSUPPORTED_STORAGE_VERSION") }
    @Synchronized fun save(value: JSONObject) { check(writableDatabase.insertWithOnConflict("transfers", null, ContentValues().apply { put("id", value.getString("id")); put("partition", value.getString("partition")); put("record", value.toString()) }, SQLiteDatabase.CONFLICT_REPLACE) != -1L) { "LOCAL_STORAGE_FAILED" } }
    @Synchronized fun list(partition: String): List<JSONObject> = readableDatabase.rawQuery("SELECT record FROM transfers WHERE partition=? ORDER BY rowid DESC", arrayOf(partition)).use { cursor -> buildList { while (cursor.moveToNext()) add(JSONObject(cursor.getString(0))) } }
}
