package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import app.uselexora.mobile.protocol.MobileContentAdapter
import app.uselexora.mobile.protocol.MobileMessage
import app.uselexora.mobile.protocol.MobileMessageDetail
import app.uselexora.mobile.protocol.MobileMessagePresentation
import org.json.JSONArray
import org.json.JSONObject

internal data class ReaderSnapshot(
    val messages: List<JSONObject>, val topic: String, val details: Map<String, MobileMessageDetail>,
    val runs: List<JSONObject>, val transcripts: Map<String, JSONObject>, val dark: Boolean,
    val fontScale: Float, val language: String, val resultRunId: String?, val avatars: Map<String, String>,
    val anchorMessageId: String? = null, val anchorRequestId: String? = null, val hasLaterMessages: Boolean = false,
    val photoEpoch: Any? = null,
    val turn: ReaderTurnContext = ReaderTurnContext(), val stepPages: Map<String, JSONObject> = emptyMap(),
    val appearanceRevision: String = "",
    val buddyNames: Map<String, String> = emptyMap(),
)

internal class ReaderProjection {
    private var sentTopic: String? = null
    private var anchorRequest: String? = null
    private var anchorTopic: String? = null
    private var sentLanguage: String? = null
    private var sentAppearance: Pair<Boolean, String>? = null
    private var sentTranscripts: Map<String, JSONObject>? = null
    private data class TranscriptPosition(val count: Int, val first: Any?, val last: Any?)
    private val transcriptPositions = mutableMapOf<String, TranscriptPosition>()
    private var sent = emptyMap<String, String>()
    private data class EncodedEntry(val message: MobileMessage, val inputs: List<Any?>, val value: JSONObject, val encoded: String)
    private val encodedEntries = mutableMapOf<String, EncodedEntry>()
    private var order = emptyList<String>()
    private var sentGroups = emptyMap<String, Pair<JSONObject, JSONObject?>>()
    private var sentAvatars: Map<String, String>? = null
    private var sentBuddyNames: Map<String, String>? = null

    fun reset() { sentTopic = null }

    private fun activityOrder(ids: List<String>, messages: List<JSONObject>, groups: List<JSONObject>): List<String> {
        val positions = ids.withIndex().associate { it.value to it.index }
        val dates = messages.associate { it.getString("id") to it.optString("createdAt") }
        val buckets = mutableMapOf<Int, MutableList<String>>()
        for (group in groups.sortedWith(compareBy<JSONObject> { it.getString("createdAt") }.thenBy { it.getString("id") })) {
            val after = positions[group.optString("afterMessageId")]
                ?: (ids.indexOfFirst { (dates[it] ?: "") > group.getString("createdAt") }.let { if (it < 0) ids.size else it } - 1)
            buckets.getOrPut(after) { mutableListOf() }.add(group.getString("id"))
        }
        return buildList {
            addAll(buckets[-1].orEmpty())
            ids.forEachIndexed { index, id -> add(id); addAll(buckets[index].orEmpty()) }
        }
    }

    fun encode(snapshot: ReaderSnapshot, appearance: () -> JSONObject, typography: () -> JSONObject,
        photoState: (JSONObject) -> ReaderPhotoState = { ReaderPhotoState("unavailable") },
    ): JSONObject = with(snapshot) {
        if (topic != sentTopic || language != sentLanguage) encodedEntries.clear()
        val active = runs.filter { it.optString("status") in setOf("queued", "running", "awaiting_approval") }.map { it.optString("id") }.toSet()
        val streaming = messages.filter { message ->
            !hasLaterMessages && message.optString("role") == "assistant" && message.optString("runId") in active &&
                (!turn.enabled || message.optJSONObject("textRange")?.optString("revision")?.toLongOrNull() != null)
        }.associate { it.optString("runId") to it.optString("id") }.values.toSet()
        val finalMessages = messages.filter { it.optString("role") == "assistant" }.associate { it.optString("runId") to it.optString("id") }
        val terminal = runs.filter { it.optString("status") in setOf("completed", "failed", "cancelled") }.associateBy { it.optString("id") }
        val entries = MobileMessagePresentation.transcript(messages) { source ->
            encodedEntries[source.getString("id")]?.message?.takeIf { it.source === source } ?: MobileMessagePresentation.message(source)
        }.map { item ->
            val message = item.message
            val commentary = if (turn.enabled && message.role == "assistant") message.source.optJSONObject("commentary") else null
            val inputs = listOf(message.source, commentary, details[message.id], item.continuation, item.showIdentity, item.intermediate,
                message.id in streaming, message.runId?.let { it in active } == true, message.runId?.let { finalMessages[it] } == message.id,
                message.runId?.let { terminal[it] }?.optString("status"),
                photoEpoch.takeIf { message.role == "user" && message.resources.isNotEmpty() })
            encodedEntries[message.id]?.takeIf { it.inputs == inputs }?.let { return@map it.value }
            val entry = JSONObject().put("id", message.id).put("continuation", item.continuation).put("messages", JSONArray(listOf(run {
                val detail = MobileMessagePresentation.matchingDetail(message.source, details[message.id])
                val text = detail?.text ?: message.text
                val runId = message.runId
                val runActive = runId != null && runId in active
                val finalAssistant = message.role == "assistant" && runId != null && finalMessages[runId] == message.id &&
                    (commentary == null || text.isNotBlank() || message.resources.isNotEmpty() || message.interrupted)
                JSONObject().put("id", message.id).apply { message.source.optString("branchId").takeIf { it.isNotBlank() }?.let { put("branchId", it) } }.put("createdAt", message.source.opt("createdAt") ?: JSONObject.NULL).put("role", message.role).put("runId", message.runId ?: JSONObject.NULL)
                    .apply {
                        (message.source.opt("turnRootId") as? String)?.let { put("turnRootId", it) }
                        (message.source.opt("turnInputId") as? String)?.let { put("turnInputId", it) }
                    }
                    .put("authorId", message.source.optJSONObject("author")?.optString("id") ?: JSONObject.NULL)
                    .put("author", message.source.optJSONObject("author")?.optString("name")?.takeIf { it.isNotBlank() } ?: mobileText(R.string.mobile_assistant))
                    .put("text", text).put("final", message.id !in streaming || message.interrupted || message.truncated)
                    .put("markdown", MobileReadingPolicy.canParse(text))
                    .put("interrupted", message.interrupted).put("truncated", message.truncated)
                    .apply {
                        if (detail?.text == null) message.source.optJSONObject("textRange")?.let { put("textRange", it) }
                        commentary?.let { put("commentary", it) }
                        if (message.truncated && (message.interrupted || message.source.has("turnInputId") || message.source.getJSONObject("body").optString("kind") == "resource")) put("sourceTruncated", true)
                    }
                    .put("showIdentity", item.showIdentity).put("intermediate", item.intermediate)
                    .put("toolName", message.toolName ?: JSONObject.NULL).put("toolSummary", if (message.role == "tool") message.text else "")
                    .put("toolTitle", MobileMessagePresentation.toolTitle(message.toolName)).put("toolError", message.toolError)
                    .put("needsDetail", message.needsDetail).put("hasDetail", detail?.text != null).put("loading", detail?.loading == true)
                    .put("error", detail?.error ?: JSONObject.NULL).put("notice", detail?.notice ?: JSONObject.NULL)
                    .put("detailResource", detail?.resource?.optString("resourceId") ?: JSONObject.NULL)
                    .put("actionsVisible", (message.role == "user" && (!message.source.optBoolean("localInput") || detail?.error != null)) || (message.role == "assistant" && !runActive && !item.intermediate && (runId == null || finalAssistant)))
                    .put("canCopy", (detail?.text != null || !message.source.has("textRange") || message.source.getJSONObject("textRange").optLong("start") == 0L) && MobileMessagePresentation.canCopy(text))
                    .apply { if (message.source.optBoolean("localInput") && detail?.error != null) put("returnToComposer", detail.canReturnToComposer) }
                    .put("canEdit", message.role == "user" && message.source.getJSONObject("body").let { it.optString("kind") == "user" && MobileContentAdapter.canEditAsText(it.getJSONObject("content")) })
                    .put("canRegenerate", finalAssistant && terminal.containsKey(runId))
                    .put("canFollowup", finalAssistant && terminal[runId]?.optString("status") == "completed")
                    .put("resources", JSONArray(message.resources.map { resource ->
                        val label = MobileReadingPolicy.resource(resource)
                        JSONObject().put("id", resource.getString("resourceId")).put("name", label.name)
                            .put("description", listOfNotNull(label.type, label.size, label.status).joinToString(" · "))
                            .put("available", label.available).apply {
                                if (ReaderMessagePhotos.isPhoto(message.role, resource)) put("photo", photoState(resource).wire(resource))
                            }
                    }))
            })))
            encodedEntries[message.id] = EncodedEntry(message, inputs, entry, entry.toString())
            entry
        }
        val reset = topic != sentTopic
        val messageOrder = entries.map { it.getString("id") }
        val groupRows = if (turn.enabled) turn.groups.associate { group ->
            val id = group.getString("id")
            id to (group to stepPages[id])
        } else emptyMap()
        val nextOrder = if (groupRows.isEmpty()) messageOrder else activityOrder(messageOrder, messages, turn.groups)
        val next = entries.associate { it.getString("id") to encodedEntries.getValue(it.getString("id")).encoded }
        encodedEntries.keys.retainAll(next.keys)
        val changed = entries.filter { reset || sent[it.getString("id")] != next[it.getString("id")] }.toMutableList()
        for ((id, row) in groupRows) if (reset || sentGroups[id] != row) {
            changed += JSONObject().put("id", id).put("continuation", true).put("messages", JSONArray())
                .put("activityGroup", row.first).put("steps", row.second)
        }
        sentGroups = groupRows
        if (anchorRequestId != null && anchorRequestId != anchorRequest) {
            anchorRequest = anchorRequestId
            anchorTopic = topic
        }
        val anchor = anchorRequestId?.takeIf { it.isNotBlank() && anchorTopic == topic && !anchorMessageId.isNullOrBlank() }
        val update = JSONObject().put("topic", topic).put("reset", reset).put("dark", dark).put("fontScale", fontScale).put("language", language)
            .put("turnWindow", turn.enabled)
            .put("canLoadTranscript", !turn.enabled && turn.client?.isConnected == true && turn.client.supports("runs.listTranscriptEvents"))
            .put("history", JSONObject().put("page", turn.historyPage).put("available", turn.historyAvailable).put("loading", turn.historyLoading).put("error", turn.historyError ?: JSONObject.NULL))
            .put("resultRunId", resultRunId ?: JSONObject.NULL)
            .put("latest", JSONObject().put("loading", turn.latestLoading).put("error", turn.latestError ?: JSONObject.NULL))
            .put("anchorMessageId", if (anchor != null) anchorMessageId else JSONObject.NULL)
            .put("anchorRequestId", anchor ?: JSONObject.NULL).put("hasLaterMessages", hasLaterMessages)
            .put("entries", JSONArray(changed)).put("runs", JSONArray(runs))
        val appearanceKey = dark to appearanceRevision
        if (reset || sentAppearance != appearanceKey) {
            update.put("appearance", appearance()).put("typography", typography())
            sentAppearance = appearanceKey
        }
        val avatarSources = avatars
        if (reset || sentAvatars !== avatarSources) { update.put("avatars", JSONObject(avatarSources)); sentAvatars = avatarSources }
        if (reset || sentBuddyNames != buddyNames) { update.put("buddyNames", JSONObject(buddyNames)); sentBuddyNames = buddyNames }
        if (reset || sentTranscripts !== transcripts) {
            val changes = JSONObject()
            if (reset) transcriptPositions.clear()
            for ((id, value) in transcripts) {
                val previous = if (reset) null else sentTranscripts?.get(id)
                if (previous === value) continue
                val events = value.optJSONArray("events") ?: JSONArray()
                val old = transcriptPositions[id]
                val append = old != null && old.count <= events.length() && (old.count == 0 ||
                    (old.first === events.opt(0) && old.last === events.opt(old.count - 1)))
                val added = JSONArray()
                for (index in (if (append) old!!.count else 0) until events.length()) added.put(events.get(index))
                changes.put(id, JSONObject().put("events", added).put("append", append).put("loaded", value.optBoolean("loaded"))
                    .put("error", value.opt("error") ?: JSONObject.NULL))
                transcriptPositions[id] = TranscriptPosition(events.length(), events.opt(0), events.opt(events.length() - 1))
            }
            transcriptPositions.keys.retainAll(transcripts.keys)
            update.put("transcripts", changes); sentTranscripts = transcripts
        }
        if (reset || order != nextOrder) update.put("order", JSONArray(nextOrder))
        sent = next; order = nextOrder; sentTopic = topic; sentLanguage = language
        update
    }

}
