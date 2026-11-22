package app.uselexora.mobile.ui

import android.os.Handler
import android.os.Looper
import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.protocol.ConversationTarget
import app.uselexora.mobile.protocol.MobileMessageDetail
import app.uselexora.mobile.protocol.MobileMessagePresentation
import app.uselexora.mobile.protocol.ProtocolFailure
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

class ReaderTurnContext(
    val target: ConversationTarget? = null,
    val client: ProductClient? = null,
    val enabled: Boolean = false,
    val groups: List<JSONObject> = emptyList(),
    val historyAvailable: Boolean = false,
    val historyLoading: Boolean = false,
    val historyError: String? = null,
    val historyPage: Int = 0,
    val latestLoading: Boolean = false,
    val latestError: String? = null,
)

internal data class ReaderStepPage(val items: List<JSONObject> = emptyList(), val cursor: String? = null,
    val loading: Boolean = false, val failed: Boolean = false, val loaded: Boolean = false, val stale: Boolean = false) {
    fun accepts(request: String?) = !loading && if (request == null) !loaded || stale else loaded && cursor == request

    fun append(result: JSONObject): ReaderStepPage {
        val values = result.getJSONArray("items")
        val next = result.opt("nextCursor") as? String
        if (next != null && next == cursor) throw ProtocolFailure("SYNC_INVALID")
        val merged = (items + (0 until values.length()).map(values::getJSONObject)).associateBy { it.getString("id") }
        if (merged.size > 10_000) throw ProtocolFailure("LIMIT_EXCEEDED")
        return ReaderStepPage(merged.values.toList(), next, loaded = true)
    }
    fun wire(details: Map<String, MobileMessageDetail>): JSONObject = JSONObject()
        .put("items", JSONArray(items.map { step ->
            val detail = (step.opt("messageId") as? String)?.let(details::get) ?: return@map step
            JSONObject(step.toString()).put("detail", JSONObject().put("loading", detail.loading).put("text", detail.text)
                .put("error", detail.error).put("notice", detail.notice).put("resourceId", detail.resource?.optString("resourceId")))
        })).put("nextCursor", cursor ?: JSONObject.NULL).put("loading", loading).put("failed", failed).apply { if (stale) put("stale", true) }
}

internal class ReaderActivitySteps(private val changed: () -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private val worker = Executors.newSingleThreadExecutor()
    private var context = ReaderTurnContext()
    private var topic = ""
    private var source: ReaderArtifactContext? = null
    private var groups = emptyMap<String, JSONObject>()
    private var pages = mutableMapOf<String, ReaderStepPage>()
    private val details = LinkedHashMap<String, MobileMessageDetail>(16, 0.75f, true)
    @Volatile private var generation = 0L
    var wire = emptyMap<String, JSONObject>()
        private set
    fun update(topic: String, turn: ReaderTurnContext, source: ReaderArtifactContext?) {
        val replaced = this.topic != topic || turn.target != context.target || turn.enabled != context.enabled
        if (replaced) { generation++; pages.clear(); details.clear(); wire = emptyMap() }
        else if (context.client !== turn.client) {
            generation++
            details.replaceAll { _, detail -> if (detail.loading) MobileMessageDetail(error = mobileText(R.string.mobile_connection_interrupted_reconnect_and_try_again)) else detail }
            pages.replaceAll { _, page -> page.copy(loading = false, failed = page.loading || page.failed, stale = page.loaded) }
            wire = pages.mapValues { it.value.wire(details) }
        }
        if (replaced || context.groups !== turn.groups) {
            val next = turn.groups.associateBy { it.getString("id") }
            for ((id, page) in pages.toMap()) {
                if (next[id] == null) { pages.remove(id); wire = wire - id }
                else if (groups[id] !== next[id] && page.loaded && !page.stale && !page.loading) {
                    pages[id] = page.copy(stale = true); publish(id)
                }
            }
            groups = next
        }
        this.topic = topic; this.source = source; context = turn
    }
    private fun publish(id: String) {
        val page = pages[id] ?: return
        wire = wire + (id to page.wire(details)); changed()
    }
    fun request(groupId: String, runId: String, cursor: String?) {
        val group = groups[groupId]?.takeIf { it.optString("runId") == runId && it.optInt("toolCount") > 0 } ?: return
        val target = context.target ?: return
        if (!context.enabled) return
        val page = pages[groupId] ?: ReaderStepPage()
        if (!page.accepts(cursor)) return
        val captured = generation
        val pending = page.copy(loading = true, failed = false)
        pages[groupId] = pending; publish(groupId)
        val client = context.client
        worker.execute {
            if (captured != generation) return@execute
            val result = runCatching {
                if (client?.supports("conversations.listActivitySteps") != true) throw ProtocolFailure("NOT_CONNECTED")
                (if (cursor == null) ReaderStepPage() else page).append(client.call("conversations.listActivitySteps", target.params().put("runId", group.getString("runId"))
                    .put("groupId", groupId).put("cursor", cursor ?: JSONObject.NULL).put("limit", 32)))
            }
            main.post {
                if (captured != generation || pages[groupId] !== pending) return@post
                val changed = group !== groups[groupId]
                pages[groupId] = result.fold({ it.copy(stale = changed || cursor != null && page.stale) },
                    { page.copy(failed = true, stale = page.stale || changed || it is ProtocolFailure && it.code == "CURSOR_EXPIRED") })
                publish(groupId)
            }
        }
    }
    fun hasPendingStep(runId: String, groupId: String, stepId: String): Boolean = groups[groupId]?.optString("runId") == runId &&
        pages[groupId]?.items?.any { it.optString("id") == stepId && it.isNull("messageId") } == true
    fun settle(groupId: String, result: JSONObject) {
        if (result.optString("status") == "running") return
        val page = pages[groupId] ?: return
        if (page.loading) return
        val step = page.items.firstOrNull { it.optString("id") == result.optString("stepId") } ?: return
        if (!step.isNull("messageId") || step.optString("status") == result.optString("status") && result.isNull("messageId")) return
        val settled = JSONObject(step.toString()).put("status", result.getString("status")).put("messageId", result.get("messageId"))
        pages[groupId] = page.copy(items = page.items.map { if (it === step) settled else it })
        publish(groupId)
    }
    private fun groupForMessage(id: String) = pages.entries.firstOrNull { (_, page) -> page.items.any { it.opt("messageId") == id } }?.key
    fun resource(id: String, resourceId: String): JSONObject? = if (groupForMessage(id) == null) null else details[id]?.resource?.takeIf { it.optString("resourceId") == resourceId }
    fun detail(id: String) {
        val groupId = groupForMessage(id) ?: return
        val prior = details[id]
        if (prior != null && prior.error == null) return
        val host = source ?: return
        val client = context.client
        val captured = generation
        val pending = MobileMessageDetail(loading = true)
        details[id] = pending; publish(groupId)
        worker.execute {
            if (captured != generation) return@execute
            val result = runCatching {
                if (client?.isConnected != true || client.identity?.partition != host.partition) throw ProtocolFailure("NOT_CONNECTED")
                val resourceId = "message:$id"
                val resource = client.callValue("resources.get", JSONObject().put("resourceId", resourceId)) as? JSONObject ?: throw ProtocolFailure("RESOURCE_UNAVAILABLE")
                if (resource.optString("resourceId") != resourceId || resource.optString("availability") != "ready") throw ProtocolFailure("RESOURCE_UNAVAILABLE")
                if (resource.getString("sizeBytes").toLong() > MobileMessagePresentation.MAX_INLINE_DETAIL_BYTES)
                    MobileMessageDetail(resource = resource, notice = mobileText(R.string.mobile_this_content_is_long_preview_save_or_share_it))
                else MobileMessagePresentation.readDetail(host.download(client, resource), resource, host.schemas, emptyList())
            }
            main.post {
                if (captured != generation || details[id] !== pending || groupForMessage(id) != groupId) return@post
                details[id] = result.getOrElse { MobileMessageDetail(error = mobileText(R.string.mobile_could_not_load_details_please_retry)) }
                while (details.size > 32 || details.values.sumOf { it.text?.length ?: 0 } > 512 * 1024) {
                    val oldest = details.entries.firstOrNull { !it.value.loading && it.key != id }?.key ?: break
                    details.remove(oldest); groupForMessage(oldest)?.let(::publish)
                }
                publish(groupId)
            }
        }
    }
    fun close() { generation++; worker.shutdownNow() }
}
