package app.uselexora.mobile.ui

import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import org.json.JSONObject

class TaskDiscoveryState {
    var supported by mutableStateOf(false)
    var archiveSupported by mutableStateOf(false)
    var archived by mutableStateOf(false)
    var query by mutableStateOf("")
    var results by mutableStateOf<List<JSONObject>>(emptyList())
    var cursor by mutableStateOf<String?>(null)
    var partial by mutableStateOf(false)
    var skippedOversized by mutableStateOf(0)
    var resultScope by mutableStateOf("")
    var loading by mutableStateOf(false)
    var error by mutableStateOf("")
    var archiveItems by mutableStateOf<List<JSONObject>>(emptyList())
    var archiveCursor by mutableStateOf<String?>(null)
    var archiveLoading by mutableStateOf(false)
    var archiveLoaded by mutableStateOf(false)
    var archiveError by mutableStateOf("")
}

@Composable
internal fun TaskDiscoveryPage(state: MobileUiState, tasks: List<JSONObject>, onAction: (MobileAction, JSONObject?) -> Unit) {
    val discovery = state.discovery
    var query by rememberSaveable { mutableStateOf("") }
    val remoteSearch = query.isNotBlank() && discovery.supported && state.connected
    val resultScope = "${discovery.archived}:${state.selectedSpaceId}"
    val base = if (discovery.archived) discovery.archiveItems.filter { state.selectedSpaceId == null || (it.opt("spaceId") as? String).orEmpty() == state.selectedSpaceId } else tasks.filter { matchesTaskFilter(it, state.taskFilter, state.markedTaskIds) }
    val local = base.filter { query.isBlank() || taskTitle(it).contains(query.trim(), true) || it.optString("previewText").contains(query.trim(), true) }
    val categoryIds = base.map { it.getString("id") }.toSet()
    val searchResults = discovery.results.filter { discovery.archived || state.taskFilter == MobileTaskFilter.All || it.optString("conversationId") in categoryIds }
    LaunchedEffect(query, discovery.archived, state.selectedSpaceId, state.connected) {
        if (query.isNotBlank() && discovery.supported && state.connected) {
            delay(250)
            onAction(MobileAction.SearchTasks, JSONObject().put("query", query.trim()))
        }
    }
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp).testTag("task-search"), singleLine = true,
            placeholder = { Text(mobileText(R.string.label_search_tasks)) }, leadingIcon = { Icon(Icons.Outlined.Search, null, Modifier.size(20.dp)) },
            trailingIcon = if (query.isNotEmpty()) ({ IconButton(onClick = { query = "" }) { Icon(Icons.Outlined.Close, mobileText(R.string.label_clear_search)) } }) else null,
            shape = MaterialTheme.shapes.medium, textStyle = MaterialTheme.typography.bodyMedium)
        if (query.isNotBlank()) Text(mobileText(if (remoteSearch) R.string.mobile_search_public_history else R.string.mobile_search_cached_summaries), Modifier.padding(horizontal = 20.dp, vertical = 4.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (state.taskSyncFailed && !discovery.archived) DiscoveryNotice(state.syncFailure.ifBlank { mobileText(R.string.label_sync_failed_showing_previously_loaded_tasks) }) { onAction(MobileAction.Refresh, null) }
        if (!state.connected && state.tasksLoaded) Text(mobileText(R.string.label_service_offline_showing_previously_synced_tasks), Modifier.padding(horizontal = 20.dp, vertical = 8.dp), style = MaterialTheme.typography.bodySmall)
        if (discovery.archived && discovery.archiveError.isNotBlank()) DiscoveryNotice(discovery.archiveError) { onAction(MobileAction.LoadArchives, null) }
        if (remoteSearch) {
            if (discovery.loading || discovery.query != query.trim()) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (discovery.query == query.trim() && discovery.resultScope == resultScope) {
                if (discovery.error.isNotEmpty()) DiscoveryNotice(discovery.error) { onAction(MobileAction.SearchTasks, JSONObject().put("query", query.trim())) }
                val showEmptyResult = !discovery.loading && discovery.error.isEmpty() && searchResults.isEmpty() && discovery.cursor == null && !discovery.partial && state.tasksLoaded && !state.taskSyncFailed
                LazyColumn(state = rememberLazyListState(), modifier = Modifier.weight(1f).fillMaxWidth().testTag("search-results"), contentPadding = if (showEmptyResult) PaddingValues(0.dp) else PaddingValues(bottom = 24.dp)) {
                    items(searchResults, key = { "${it.optString("kind")}:${it.optString("conversationId")}:${it.optString("branchId")}:${it.optString("messageId")}" }) { hit ->
                        Column(Modifier.fillMaxWidth().clickable(role = Role.Button) { onAction(MobileAction.OpenSearchHit, hit) }.padding(horizontal = 20.dp, vertical = 12.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                            Text(taskTitle(hit), style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                            Text(mobileText(if (hit.optString("kind") == "message") R.string.mobile_message_match else R.string.mobile_task_match), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                            if (hit.optString("snippet").isNotBlank()) Text(hit.getString("snippet"), style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
                            if (hit.optString("kind") == "message") {
                                val time = runCatching { java.time.Instant.parse(hit.getString("createdAt")).toEpochMilli() }.getOrNull()
                                Text(mobileText(if (hit.optString("role") == "user") R.string.mobile_me else R.string.mobile_assistant) + (time?.let { " · " + java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT, app.uselexora.mobile.i18n.MobileStrings.locale).format(java.util.Date(it)) } ?: ""), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        HorizontalDivider(Modifier.padding(horizontal = 20.dp), color = MaterialTheme.colorScheme.outlineVariant)
                    }
                    if (showEmptyResult) item { DiscoveryEmptyState(mobileText(R.string.label_task_not_found), Modifier.fillParentMaxSize()) }
                    if (discovery.partial) item { Text(mobileText(R.string.mobile_search_partial), Modifier.padding(20.dp), style = MaterialTheme.typography.bodySmall) }
                    if (discovery.cursor != null) item { TextButton(onClick = { onAction(MobileAction.SearchTasks, JSONObject().put("query", query.trim()).put("more", true)) }, enabled = !discovery.loading) { Text(mobileText(R.string.mobile_load_more_results)) } }
                }
            }
        } else {
            if (discovery.archiveLoading) LinearProgressIndicator(Modifier.fillMaxWidth())
            val centerEmptyState = local.isEmpty() && (!discovery.archived || discovery.archiveCursor == null)
            LazyColumn(state = rememberLazyListState(), modifier = Modifier.weight(1f).fillMaxWidth().testTag("task-list"), contentPadding = if (centerEmptyState) PaddingValues(0.dp) else PaddingValues(bottom = 24.dp)) {
                if (local.isEmpty()) item {
                    DiscoveryEmptyState(
                        mobileText(when { query.isNotBlank() -> R.string.label_task_not_found; discovery.archived && !discovery.archiveLoaded -> R.string.label_syncing_tasks; !discovery.archived && !state.tasksLoaded -> R.string.label_syncing_tasks; else -> R.string.mobile_no_tasks_in_scope }),
                        if (centerEmptyState) Modifier.fillParentMaxSize() else Modifier.fillMaxWidth(),
                    )
                }
                items(local, key = { it.getString("id") }) { task ->
                    when {
                        discovery.archived -> TaskRow(task, state.spaces, { onAction(MobileAction.OpenArchivedTask, task) }, mobileText(R.string.mobile_restore_task)) { onAction(MobileAction.RestoreArchivedTask, task) }
                        state.taskFilter == MobileTaskFilter.Approvals -> TaskRow(task, state.spaces, { onAction(MobileAction.OpenTask, task) }, mobileText(R.string.label_review)) { onAction(MobileAction.ReviewTaskApproval, task) }
                        state.taskFilter == MobileTaskFilter.Questions -> TaskRow(task, state.spaces, { onAction(MobileAction.OpenTaskQuestions, task) }, mobileText(R.string.question_answers)) { onAction(MobileAction.OpenTaskQuestions, task) }
                        state.taskFilter == MobileTaskFilter.Unread && task.optString("resultBranchId").isNotBlank() -> TaskRow(task, state.spaces, { onAction(MobileAction.OpenTask, task) }, mobileText(R.string.label_view_result)) { onAction(MobileAction.OpenTaskResult, task) }
                        else -> TaskRow(task, state.spaces, { onAction(MobileAction.OpenTask, task) })
                    }
                }
                if (discovery.archived && discovery.archiveCursor != null) item { TextButton(onClick = { onAction(MobileAction.LoadArchives, JSONObject().put("more", true)) }, enabled = !discovery.archiveLoading) { Text(mobileText(R.string.mobile_load_more_results)) } }
            }
        }
    }
}

@Composable
private fun DiscoveryEmptyState(message: String, modifier: Modifier) {
    Box(modifier.padding(24.dp), contentAlignment = Alignment.Center) {
        Text(message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
    }
}

@Composable
internal fun DiscoveryNotice(message: String, retry: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(message, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
        TextButton(onClick = retry) { Text(mobileText(R.string.label_retry)) }
    }
}
