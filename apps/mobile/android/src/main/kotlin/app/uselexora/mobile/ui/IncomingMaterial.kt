package app.uselexora.mobile.ui

import app.uselexora.mobile.R
import android.content.Intent
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

internal class IncomingMaterialFailure(val messageResource: Int) : IllegalArgumentException()

data class IncomingMaterial(val id: String, val text: String, val uris: List<Uri>, val partition: String? = null, val scope: String? = null) {
    fun json() = JSONObject().put("id", id).put("text", text).put("uris", JSONArray(uris.map(Uri::toString))).put("partition", partition).put("scope", scope)
    companion object {
        fun restore(value: JSONObject) = IncomingMaterial(value.getString("id"), value.getString("text"), value.getJSONArray("uris").let { values -> (0 until values.length()).map { Uri.parse(values.getString(it)) } }, value.optString("partition").takeUnless { it.isBlank() || it == "null" }, value.optString("scope").takeUnless { it.isBlank() || it == "null" })
        @Suppress("DEPRECATION")
        fun read(intent: Intent, packageName: String): IncomingMaterial? {
            if (intent.action !in setOf(Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE)) return null
            val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString().orEmpty()
            if (text.length > 65536) throw IncomingMaterialFailure(R.string.incoming_text_limit)
            val uris = buildList {
                if (intent.action == Intent.ACTION_SEND_MULTIPLE) intent.getParcelableArrayListExtra<android.os.Parcelable>(Intent.EXTRA_STREAM)?.filterIsInstance<Uri>()?.let(::addAll)
                else (intent.getParcelableExtra<android.os.Parcelable>(Intent.EXTRA_STREAM) as? Uri)?.let(::add)
                intent.clipData?.let { data -> if (data.itemCount > 16) throw IncomingMaterialFailure(R.string.incoming_file_limit); for (index in 0 until data.itemCount) data.getItemAt(index).uri?.let(::add) }
            }.distinct()
            if (uris.size > 16) throw IncomingMaterialFailure(R.string.incoming_file_limit)
            if (uris.any { it.scheme != "content" || it.authority == "$packageName.files" }) throw IncomingMaterialFailure(R.string.incoming_invalid_source)
            if (text.isBlank() && uris.isEmpty()) throw IncomingMaterialFailure(R.string.incoming_empty)
            return IncomingMaterial(UUID.randomUUID().toString(), text, uris)
        }
    }
}
