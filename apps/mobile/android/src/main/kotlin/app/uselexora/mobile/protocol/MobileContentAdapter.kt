package app.uselexora.mobile.protocol

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import org.json.JSONArray
import org.json.JSONObject

object MobileContentAdapter {
    enum class Presentation { InputPreview, Message }
    private enum class Kind { Text, Break, Resource, Actor, Session, Quote, Directive, Unknown }
    private data class Node(val kind: Kind, val value: String = "", val reference: JSONObject? = null, val editable: Boolean = false)
    private data class Document(val paragraphs: List<List<Node>>, val editable: Boolean, val unsupported: String? = null)

    fun textContent(text: String) = JSONObject().put("version", 1).put("body", JSONArray().put(
        JSONObject().put("type", "paragraph").put("content", if (text.isEmpty()) JSONArray() else JSONArray().put(JSONObject().put("type", "text").put("text", text)))
    )).put("panelResourceIds", JSONArray())

    fun text(content: JSONObject, presentation: Presentation = Presentation.InputPreview, resources: List<JSONObject> = emptyList()): String {
        val document = decode(content)
        document.unsupported?.let { return it.ifBlank { if (presentation == Presentation.InputPreview) mobileText(R.string.mobile_view_this_content_on_the_desktop) else "" } }
        return document.paragraphs.joinToString("\n") { nodes -> nodes.joinToString("") { node ->
            when (node.kind) {
                Kind.Text -> node.value
                Kind.Break -> "\n"
                Kind.Actor -> "@${node.value}"
                Kind.Resource -> if (presentation == Presentation.Message) resources.firstOrNull { it.optString("bindingId") == node.value }
                    ?.let { "[${it.optString("name", mobileText(R.string.mobile_attachment))}]" } ?: mobileText(R.string.mobile_attachment_2) else mobileText(R.string.mobile_attachment_2)
                Kind.Session -> node.reference?.let { mobileText(R.string.mobile_related_task, it.optString("title")) }
                    ?: if (presentation == Presentation.Message) mobileText(R.string.mobile_related_task_2) else mobileText(R.string.mobile_related_task_untitled_task)
                Kind.Quote -> node.reference?.let {
                    if (presentation == Presentation.Message) "\n> ${it.optString("text").replace("\n", "\n> ")}\n"
                    else mobileText(R.string.mobile_quote, summary(it.optString("text"), 240))
                } ?: mobileText(R.string.mobile_quote_unavailable)
                Kind.Directive -> node.value.ifBlank { if (presentation == Presentation.Message) mobileText(R.string.mobile_instruction) else mobileText(R.string.mobile_view_this_instruction_on_the_desktop) }
                Kind.Unknown -> if (presentation == Presentation.Message) mobileText(R.string.mobile_unrecognized_content) else mobileText(R.string.mobile_view_this_content_on_the_desktop_2)
            }
        } }
    }

    fun canEditAsText(content: JSONObject): Boolean = decode(content).editable
    fun summary(text: String, limit: Int): String {
        require(limit > 0)
        if (text.codePointCount(0, text.length) <= limit) return text
        return text.substring(0, text.offsetByCodePoints(0, limit)) + "…"
    }

    private fun decode(wrapper: JSONObject): Document {
        if (wrapper.optString("kind") == "unsupported") return Document(emptyList(), false, wrapper.optString("summary"))
        val content = if (wrapper.optString("kind") == "editable") wrapper.optJSONObject("content") ?: return Document(listOf(listOf(Node(Kind.Unknown))), false) else wrapper
        val body = content.optJSONArray("body") ?: return Document(listOf(listOf(Node(Kind.Text, content.optString("text")))), false)
        var editable = content.optInt("version") == 1 && content.only("version", "body", "panelResourceIds") && body.length() > 0
        fun reference(key: String, id: String) = objects(content.optJSONArray(key)).firstOrNull { it.optString("id") == id }
        val paragraphs = (0 until body.length()).map { index ->
            val paragraph = body.optJSONObject(index)
            val nodes = paragraph?.optJSONArray("content")
            if (paragraph?.optString("type") != "paragraph" || !paragraph.only("type", "content") || nodes == null) editable = false
            if (nodes == null) listOf(Node(Kind.Unknown)) else (0 until nodes.length()).map { offset ->
                val item = nodes.optJSONObject(offset)
                val node = when (item?.optString("type")) {
                    "text" -> Node(Kind.Text, item.optString("text"), editable = item.only("type", "text") && item.opt("text") is String && item.getString("text").isNotEmpty())
                    "hard_break" -> Node(Kind.Break, editable = item.only("type"))
                    "resource_ref" -> Node(Kind.Resource, item.optString("resourceId"))
                    "actor_ref" -> Node(Kind.Actor, item.optString("name"))
                    "session_ref" -> Node(Kind.Session, reference = reference("sessionReferences", item.optString("sessionId")))
                    "quote_ref" -> Node(Kind.Quote, reference = reference(if (item.optString("quoteKind") == "message") "quotes" else "resourceQuotes", item.optString("quoteId")))
                    "prompt_directive" -> Node(Kind.Directive, item.optString("value"))
                    else -> Node(Kind.Unknown)
                }
                if (!node.editable) editable = false
                node
            }
        }
        return Document(paragraphs, editable)
    }
    private fun JSONObject?.only(vararg allowed: String) = this != null && keys().asSequence().all { it in allowed }
    private fun objects(array: JSONArray?): List<JSONObject> = if (array == null) emptyList() else (0 until array.length()).mapNotNull { array.optJSONObject(it) }
}
