package app.uselexora.mobile.protocol

import org.json.JSONObject

internal object ProductLiveText {
    private const val WINDOW = 16_384

    fun append(message: JSONObject, change: JSONObject) {
        val current = message.optJSONObject("textRange") ?: return
        if (current.getString("revision").startsWith("s:")) return
        val body = message.getJSONObject("body")
        val next = change.getJSONObject("range")
        val text = change.getString("text")
        val start = next.getLong("start"); val end = next.getLong("end")
        val previousRevision = change.getString("previousRevision").toBigInteger()
        val revision = next.getString("revision").toBigInteger()
        if (body.optString("kind") != "text" || start < 0 || end < start || end != next.getLong("total") || end - start != text.length.toLong() ||
            text.length > WINDOW || previousRevision >= revision) throw ProtocolFailure("SYNC_INVALID")
        val oldRevision = current.getString("revision").toBigInteger()
        if (revision <= oldRevision) return
        val previous = body.getString("text")
        val continuous = previousRevision == oldRevision && start == current.getLong("end") &&
            start - current.getLong("start") == previous.length.toLong()
        val merged = if (continuous) previous + text else text
        var from = maxOf(0, merged.length - WINDOW)
        if (from > 0 && Character.isSurrogatePair(merged[from - 1], merged[from])) from++
        val visible = merged.substring(from)
        body.put("text", visible)
        message.put("textRange", JSONObject(next.toString()).put("start", end - visible.length))
    }
}
