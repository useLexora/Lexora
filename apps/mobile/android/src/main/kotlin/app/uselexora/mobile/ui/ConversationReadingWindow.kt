package app.uselexora.mobile.ui

import org.json.JSONObject

internal fun needsFreshCachedStructure(hasTurnWindow: Boolean, messages: List<JSONObject>, supports: (String) -> Boolean) =
    !hasTurnWindow && (supports("conversations.getTurnWindow") || supports("runs.listTranscriptEvents")) &&
        messages.any { it.optString("role") == "assistant" && !it.isNull("runId") }

internal data class ConversationPage(
    val messages: List<JSONObject> = emptyList(),
    val groups: List<JSONObject> = emptyList(),
    val runs: List<JSONObject> = emptyList(),
    val next: String? = null,
) {
    fun prepend(older: ConversationPage): ConversationPage {
        fun merge(before: List<JSONObject>, after: List<JSONObject>) = (before + after).associateBy { it.getString("id") }.values.toList()
        return ConversationPage(merge(older.messages, messages).sortedWith(compareBy<JSONObject> { it.optString("createdAt") }.thenBy { it.getString("id") }),
            merge(older.groups, groups), merge(older.runs, runs), older.next)
    }
}

internal class ConversationReadingWindow {
    enum class Mode { Latest, Paged, Search, Detached }
    data class Request(val snapshot: Long?, val mode: Mode, val cursor: String)
    private var snapshot: Long? = null
    private var earlier: ConversationPage? = null
    private var disconnectedSearch = false
    var latest = ConversationPage()
        private set
    var display = latest
        private set
    var mode = Mode.Latest
        private set
    fun project(serial: Long, page: ConversationPage): Boolean {
        val replaced = (snapshot != null && snapshot != serial) || disconnectedSearch
        if (replaced && mode != Mode.Latest) { mode = Mode.Detached; earlier = null }
        disconnectedSearch = false
        snapshot = serial; latest = page
        if (mode == Mode.Latest || mode == Mode.Paged) display = earlier?.let(page::prepend) ?: page
        return replaced
    }
    fun disconnected() { if (mode == Mode.Search && snapshot == null) disconnectedSearch = true }
    fun pin(page: ConversationPage) { earlier = null; mode = Mode.Search; display = page }
    fun request(): Request? = if (mode == Mode.Detached) null else display.next?.let { Request(snapshot, mode, it) }
    fun append(request: Request, page: ConversationPage): Boolean {
        if (request != request()) return false
        if (mode == Mode.Search) display = display.prepend(page)
        else {
            val merged = earlier?.prepend(page) ?: page
            earlier = merged; display = latest.prepend(merged); mode = Mode.Paged
        }
        return true
    }
    fun resume(page: ConversationPage = latest) {
        disconnectedSearch = false; earlier = null; mode = Mode.Latest; latest = page; display = page
    }
}
