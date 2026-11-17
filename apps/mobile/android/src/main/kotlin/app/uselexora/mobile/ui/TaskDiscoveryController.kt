package app.uselexora.mobile.ui

import app.uselexora.mobile.network.ProductClient
import app.uselexora.mobile.session.MobileOperationFailure
import org.json.JSONObject

internal class TaskDiscoveryController(
    private val state: MobileUiState,
    private val client: () -> ProductClient?,
    private val owner: () -> String,
    private val work: (() -> Unit) -> Unit,
    private val onUi: (() -> Unit) -> Unit,
) {
    private var searchGeneration = 0L
    private var archiveGeneration = 0L
    private var memberGeneration = 0L
    private fun cursor(page: JSONObject) = (page.opt("nextCursor") as? String)?.takeIf { it.isNotBlank() }
    private fun items(page: JSONObject) = page.getJSONArray("items").let { values -> (0 until values.length()).map { values.getJSONObject(it) } }
    private fun message(error: Exception) = MobileFailurePresentation.message(MobileOperationFailure.from(error))

    fun search(query: String, more: Boolean = false) {
        val current = client()?.takeIf { it.isConnected && it.supports("conversations.search") } ?: return
        val target = state.discovery
        if (more && (target.loading || target.query != query || target.cursor == null)) return
        val captured = owner()
        val request = ++searchGeneration
        val params = JSONObject().put("query", query).put("scope", if (target.archived) "archived" else "active").put("limit", 50)
        state.selectedSpaceId?.let { params.put("spaceId", if (it.isEmpty()) JSONObject.NULL else it) }
        if (more) params.put("cursor", target.cursor)
        target.query = query; target.loading = true; target.error = ""
        target.resultScope = "${target.archived}:${state.selectedSpaceId}"
        if (!more) { target.results = emptyList(); target.cursor = null; target.partial = false; target.skippedOversized = 0 }
        work {
            try {
                val page = current.call("conversations.search", params)
                onUi {
                    if (state.discovery !== target || owner() != captured || client() !== current || searchGeneration != request) return@onUi
                    target.results = ((if (more) target.results else emptyList()) + items(page)).distinctBy { "${it.optString("kind")}:${it.optString("conversationId")}:${it.optString("branchId")}:${it.optString("messageId")}" }
                    target.skippedOversized += page.optInt("skippedOversized")
                    target.cursor = cursor(page); target.partial = target.cursor != null || target.skippedOversized > 0
                    target.loading = false
                }
            } catch (error: Exception) { onUi { if (state.discovery === target && owner() == captured && searchGeneration == request) { target.loading = false; target.error = message(error) } } }
        }
    }

    fun archives(more: Boolean = false) {
        val current = client()?.takeIf { it.isConnected && it.supports("conversations.listArchived") } ?: return
        val target = state.discovery
        if (more && (target.archiveLoading || target.archiveCursor == null)) return
        val captured = owner(); val request = ++archiveGeneration
        val params = JSONObject().put("kind", "archived").put("limit", 100)
        state.selectedSpaceId?.let { params.put("spaceId", if (it.isEmpty()) JSONObject.NULL else it) }
        if (more) params.put("cursor", target.archiveCursor)
        target.archiveLoading = true; target.archiveError = ""
        work {
            try {
                val page = current.call("conversations.listArchived", params)
                onUi {
                    if (state.discovery !== target || owner() != captured || client() !== current || request != archiveGeneration) return@onUi
                    target.archiveItems = ((if (more) target.archiveItems else emptyList()) + items(page)).distinctBy { it.getString("id") }
                    target.archiveCursor = cursor(page); target.archiveLoaded = true; target.archiveLoading = false
                }
            } catch (error: Exception) { onUi { if (state.discovery === target && owner() == captured && request == archiveGeneration) { target.archiveLoading = false; target.archiveError = message(error) } } }
        }
    }

    fun members() {
        val task = state.selectedTask ?: return
        state.membersOpen = true
        val current = client()?.takeIf { it.isConnected && it.supports("conversations.listMembers") && it.supports("buddies.list") } ?: run { state.membersLoading = false; state.membersError = MobileFailurePresentation.NETWORK_UNAVAILABLE_NOTICE; return }
        val captured = owner(); val request = ++memberGeneration
        state.membersLoading = true; state.membersError = ""
        work {
            try {
                fun collect(method: String, params: JSONObject): Pair<JSONObject, List<JSONObject>> {
                    var next: String? = null
                    val result = mutableListOf<JSONObject>()
                    var first: JSONObject? = null
                    do {
                        val page = current.call(method, JSONObject(params.toString()).put("limit", 100).put("cursor", next ?: JSONObject.NULL))
                        if (first == null) first = page
                        else if (listOf("revision", "catalogRevision").any { first!!.optString(it) != page.optString(it) }) throw app.uselexora.mobile.protocol.ProtocolFailure("DRAFT_CONFLICT")
                        result.addAll(items(page)); next = cursor(page)
                        if (result.size > 1000) throw app.uselexora.mobile.protocol.ProtocolFailure("LIMIT_EXCEEDED")
                    } while (next != null)
                    return first!! to result
                }
                val (memberPage, members) = collect("conversations.listMembers", JSONObject().put("conversationId", task.getString("id")))
                val (_, catalog) = collect("buddies.list", JSONObject())
                onUi {
                    if (owner() != captured || client() !== current || request != memberGeneration || !state.membersOpen) return@onUi
                    state.members = JSONObject(memberPage.toString()).put("items", org.json.JSONArray(members))
                    state.buddyCatalog = catalog; state.membersLoading = false
                }
            } catch (error: Exception) { onUi { if (owner() == captured && request == memberGeneration) { state.membersLoading = false; state.membersError = message(error) } } }
        }
    }
}
