package app.uselexora.mobile.protocol

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class MobileMessageDetail(
    val text: String? = null,
    val loading: Boolean = false,
    val error: String? = null,
    val resource: JSONObject? = null,
    val notice: String? = null,
    val sourceBody: String? = null,
)

data class MobileMessage(
    val source: JSONObject,
    val id: String,
    val runId: String?,
    val role: String,
    val text: String,
    val resources: List<JSONObject>,
    val needsDetail: Boolean,
    val interrupted: Boolean,
    val truncated: Boolean,
    val toolName: String?,
    val toolError: Boolean,
    val canGroup: Boolean,
)

data class MobileTranscriptItem(val message: MobileMessage, val showIdentity: Boolean, val continuation: Boolean, val intermediate: Boolean)

data class MobileTimelineEntry(val id: String, val messages: List<MobileMessage>)

object MobileMessagePresentation {
    const val MAX_INLINE_DETAIL_BYTES = 256 * 1024
    const val MAX_CLIPBOARD_PAYLOAD_BYTES = 128 * 1024

    fun canCopy(text: String): Boolean = (text.length.toLong() + 1) * Char.SIZE_BYTES + 128 <= MAX_CLIPBOARD_PAYLOAD_BYTES

    fun matchingDetail(source: JSONObject, detail: MobileMessageDetail?): MobileMessageDetail? = detail?.takeIf {
        it.sourceBody == null || it.sourceBody == source.getJSONObject("body").toString()
    }

    fun readDetail(file: File, resource: JSONObject, schemas: ProtocolSchemas, resources: List<JSONObject>): MobileMessageDetail {
        fun fileOnly() = MobileMessageDetail(resource = resource, notice = mobileText(R.string.mobile_this_content_is_long_preview_save_or_share_it))
        if (file.length() > MAX_INLINE_DETAIL_BYTES) return fileOnly()
        val buffer = ByteArray(MAX_INLINE_DETAIL_BYTES + 1)
        val length = file.inputStream().use { input ->
            var count = 0
            while (count < buffer.size) {
                val read = input.read(buffer, count, buffer.size - count)
                if (read < 0) break
                count += read
            }
            count
        }
        if (length > MAX_INLINE_DETAIL_BYTES) return fileOnly()
        val document = String(buffer, 0, length, Charsets.UTF_8)
        val text = when (resource.optString("mimeType").substringBefore(';').trim().lowercase(java.util.Locale.ROOT)) {
            "text/plain", "text/markdown" -> document
            "application/json" -> runCatching {
                val wrapper = JSONObject().put("kind", "editable").put("content", JSONObject(document))
                if (schemas.content(wrapper)) userText(wrapper, resources) else null
            }.getOrNull()
            else -> null
        }
        return if (text == null) MobileMessageDetail(resource = resource, notice = mobileText(R.string.mobile_this_content_cannot_be_displayed_in_the_conversation_open))
        else MobileMessageDetail(text = text, resource = resource)
    }

    fun message(source: JSONObject): MobileMessage {
        val body = source.getJSONObject("body")
        val role = source.getString("role")
        val resources = objects(source.optJSONArray("resources"))
        val tool = source.optJSONObject("tool")
        val toolName = tool?.optString("name")?.takeIf { it.isNotBlank() }
        val content = body.optJSONObject("content")
        val text = when (body.getString("kind")) {
            "user" -> content?.let { userText(it, resources) }.orEmpty()
            "text" -> body.optString("text")
            else -> body.optString("previewText")
        }
        val needsDetail = body.optString("kind") == "resource" || body.optBoolean("truncated") || content?.optString("kind") == "unsupported"
        val toolError = tool?.optBoolean("isError") == true
        val canGroup = role == "tool" && toolName != null && tool?.has("isError") == true && !toolError &&
            toolName !in setOf("lexora_ask_user", "lexora_wait_user", "AskUserQuestion") && !body.optBoolean("interrupted")
        return MobileMessage(
            source, source.getString("id"), source.optString("runId").takeUnless { it.isBlank() || it == "null" },
            role, text, resources, needsDetail, body.optBoolean("interrupted"), body.optBoolean("truncated"), toolName, toolError, canGroup,
        )
    }

    fun entries(messages: List<JSONObject>, readMessage: (JSONObject) -> MobileMessage = ::message): List<MobileTimelineEntry> {
        val entries = mutableListOf<MobileTimelineEntry>()
        for (source in messages) {
            val message = readMessage(source)
            if (message.role == "assistant" && message.text.isBlank() && message.resources.isEmpty() && !message.needsDetail && !message.interrupted) continue
            val previous = entries.lastOrNull()
            if (message.canGroup && previous?.messages?.lastOrNull()?.let { it.canGroup && it.runId == message.runId } == true) {
                entries[entries.lastIndex] = previous.copy(messages = previous.messages + message)
            } else {
                entries.add(MobileTimelineEntry(message.id, listOf(message)))
            }
        }
        return entries
    }

    fun transcript(messages: List<JSONObject>, readMessage: (JSONObject) -> MobileMessage = ::message): List<MobileTranscriptItem> {
        val visible = entries(messages, readMessage).flatMap { it.messages }
        val finalReplies = visible.filter { it.role == "assistant" && it.runId != null }.associate { it.runId to it.id }
        var speaker: Pair<String?, String?>? = null
        var previous: MobileMessage? = null
        return visible.map { message ->
            val identity = message.runId to message.source.optJSONObject("author")?.optString("id")
            val showIdentity = message.role == "assistant" && (message.runId == null || speaker != identity)
            val continuation = message.role != "user" && previous?.role != "user" && message.runId != null && previous?.runId == message.runId
            if (message.role == "assistant") speaker = identity
            else if (message.role == "user" || message.runId != previous?.runId) speaker = null
            previous = message
            MobileTranscriptItem(message, showIdentity, continuation,
                message.role == "assistant" && message.runId != null && finalReplies[message.runId] != message.id)
        }
    }

    fun toolTitle(name: String?): String = when (name) {
        "read" -> mobileText(R.string.mobile_read_content)
        "write" -> mobileText(R.string.mobile_write_files)
        "edit" -> mobileText(R.string.mobile_edit_files)
        "bash", "shell", "exec_command" -> mobileText(R.string.review_execute_command)
        "grep", "find", "search", "lexora_tool_search" -> mobileText(R.string.mobile_search)
        "lexora_ask_user", "AskUserQuestion" -> mobileText(R.string.mobile_ask_a_question)
        "lexora_wait_user" -> mobileText(R.string.mobile_wait_for_an_answer)
        null -> mobileText(R.string.mobile_tool_call)
        else -> name
    }

    fun groupSummary(messages: List<MobileMessage>): String = messages.groupingBy { toolTitle(it.toolName) }.eachCount()
        .entries.joinToString(" · ") { (name, count) -> if (count == 1) name else "$name × $count" }

    private fun userText(wrapper: JSONObject, resources: List<JSONObject>) = MobileContentAdapter.text(wrapper, MobileContentAdapter.Presentation.Message, resources)
    private fun objects(array: JSONArray?): List<JSONObject> = if (array == null) emptyList() else (0 until array.length()).mapNotNull { array.optJSONObject(it) }
}
