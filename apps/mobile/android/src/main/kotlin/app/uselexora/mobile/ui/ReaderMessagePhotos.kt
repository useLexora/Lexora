package app.uselexora.mobile.ui

import app.uselexora.mobile.preview.PreviewKind
import app.uselexora.mobile.preview.PreviewPolicy
import org.json.JSONObject

internal data class ReaderPhotoState(val status: String, val thumbnail: String? = null) {
    fun wire(resource: JSONObject) = JSONObject().put("revision", resource.getString("revision")).put("status", status).apply {
        thumbnail?.let { put("thumbnail", it) }
    }
}

internal object ReaderMessagePhotos {
    fun isPhoto(role: String, resource: JSONObject): Boolean = role == "user" && resource.optString("kind") == "attachment" &&
        (resource.opt("revision") as? String)?.isNotBlank() == true && PreviewPolicy.kind(resource.optString("name"), resource.optString("mimeType")) == PreviewKind.IMAGE

    fun canLoad(resource: JSONObject) = resource.optString("availability") == "ready" && withinThumbnailLimit(resource)

    fun resolve(message: JSONObject?, action: JSONObject): JSONObject? {
        if (message == null || message.optString("id") != action.optString("id")) return null
        val resources = message.optJSONArray("resources") ?: return null
        for (index in 0 until resources.length()) {
            val resource = resources.optJSONObject(index) ?: continue
            if (resource.optString("resourceId") == action.optString("resourceId") && resource.optString("revision") == action.optString("revision") &&
                isPhoto(message.optString("role"), resource)) return resource
        }
        return null
    }
}
