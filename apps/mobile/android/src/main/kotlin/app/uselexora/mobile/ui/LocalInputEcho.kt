package app.uselexora.mobile.ui

import app.uselexora.mobile.session.MobileOperationOwner
import org.json.JSONObject
import java.time.Instant
import java.util.UUID

/** View-only: the original input and command receipt remain owned by the composer/outbox. */
internal class LocalInputEcho(val owner: MobileOperationOwner, val text: String, val attachments: List<MobileAttachmentItem>, before: List<JSONObject>) {
    val id = "local:${UUID.randomUUID()}"
    val row = JSONObject().put("id", id).put("role", "user").put("localInput", true).put("createdAt", Instant.now().toString())
        .put("body", JSONObject().put("kind", "text").put("text", (listOf(text).filter(String::isNotBlank) + attachments.map { it.name }).joinToString("\n")))
    private val previousUsers = before.filter { it.optString("role") == "user" }.mapTo(mutableSetOf()) { it.getString("id") }
    var failure: String? = null
    var nextEdit = false

    fun belongsTo(current: MobileOperationOwner) = owner.partition == current.partition && owner.visit == current.visit &&
        owner.inputScope == current.inputScope && owner.topic == current.topic && owner.view == current.view

    fun display(messages: List<JSONObject>): List<JSONObject> {
        // A projection can beat the receipt identifying its user message. Hold that tail, never match by text.
        val firstUnconfirmed = if (failure == null) messages.indexOfFirst { it.optString("role") == "user" && it.getString("id") !in previousUsers } else -1
        return (if (firstUnconfirmed < 0) messages else messages.subList(0, firstUnconfirmed)) + row
    }
}
