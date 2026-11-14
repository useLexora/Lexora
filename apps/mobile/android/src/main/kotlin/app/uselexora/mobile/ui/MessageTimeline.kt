package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ChevronRight
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.InsertDriveFile
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.uselexora.mobile.protocol.MobileMessage
import app.uselexora.mobile.protocol.MobileMessageDetail
import app.uselexora.mobile.protocol.MobileMessagePresentation
import org.json.JSONObject
import kotlinx.coroutines.launch

@Composable
fun MessageTimeline(
    messages: List<JSONObject>,
    topic: String,
    modifier: Modifier = Modifier,
    details: Map<String, MobileMessageDetail> = emptyMap(),
    onMessageAction: (JSONObject) -> Unit,
    onResource: (JSONObject) -> Unit,
    onLoadDetail: (JSONObject) -> Unit,
) {
    key(topic) {
        val entries = MobileMessagePresentation.entries(messages)
        val listState = rememberLazyListState()
        val markdownCache = remember { MobileMarkdownCache() }
        var renderVersion by remember { mutableIntStateOf(0) }
        var followsEnd by rememberSaveable { mutableStateOf(true) }
        var automaticScroll by remember { mutableStateOf(false) }
        val coroutineScope = rememberCoroutineScope()
        var disclosures by rememberSaveable { mutableStateOf(hashMapOf<String, Boolean>()) }
        fun disclose(id: String, expanded: Boolean) {
            followsEnd = false
            disclosures = HashMap(disclosures).apply { put(id, expanded) }
        }
        val loadDetail: (JSONObject) -> Unit = { followsEnd = false; onLoadDetail(it) }
        fun detailFor(message: MobileMessage): MobileMessageDetail? = MobileMessagePresentation.matchingDetail(message.source, details[message.id])
        val update = entries.map { entry -> entry.messages.map { listOf(it.id, it.text, it.needsDetail, it.interrupted, it.truncated, it.resources.size) } }
        LaunchedEffect(listState) {
            snapshotFlow { listState.isScrollInProgress to listState.canScrollForward }.collect { (scrolling, hasMore) ->
                if (scrolling && !automaticScroll) followsEnd = !hasMore
            }
        }
        LaunchedEffect(update, renderVersion) {
            if (followsEnd && entries.isNotEmpty() && !listState.isScrollInProgress) {
                automaticScroll = true
                try { scrollToEnd(listState, entries.size) } finally { automaticScroll = false }
            }
        }
        Box(modifier) {
        LazyColumn(
            modifier = Modifier.fillMaxSize().testTag("message-list"),
            state = listState,
            contentPadding = PaddingValues(horizontal = 20.dp, vertical = 18.dp),
            verticalArrangement = Arrangement.spacedBy(22.dp),
        ) {
            items(entries, key = { it.id }) { entry ->
                if (entry.messages.size > 1) {
                    val expanded = disclosures["group:${entry.id}"] ?: entry.messages.any { disclosures[it.id] == true }
                    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        ToolHeader(MobileMessagePresentation.groupSummary(entry.messages), expanded, false) { disclose("group:${entry.id}", !expanded) }
                        if (expanded) entry.messages.forEach { message ->
                            key(message.id) { ToolMessage(message, detailFor(message), disclosures[message.id] ?: message.toolError, { disclose(message.id, it) }, onMessageAction, onResource, loadDetail) }
                        }
                    }
                } else {
                    val message = entry.messages.single()
                    if (message.role == "tool") ToolMessage(message, detailFor(message), disclosures[message.id] ?: message.toolError, { disclose(message.id, it) }, onMessageAction, onResource, loadDetail)
                    else ConversationMessage(message, detailFor(message), markdownCache, { renderVersion++ }, onMessageAction, onResource, loadDetail)
                }
            }
        }
        if (!followsEnd && listState.canScrollForward) {
            FilledTonalButton(
                onClick = {
                    followsEnd = true
                    coroutineScope.launch {
                        automaticScroll = true
                        try { scrollToEnd(listState, entries.size) } finally { automaticScroll = false }
                    }
                },
                modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 12.dp),
            ) { Text(mobileText(R.string.mobile_jump_to_latest)) }
        }
        }
    }
}

private suspend fun scrollToEnd(state: LazyListState, count: Int) {
    if (count == 0) return
    withFrameNanos { }
    state.scrollToItem(count - 1)
    withFrameNanos { }
    val last = state.layoutInfo.visibleItemsInfo.lastOrNull()
    if (last?.index == count - 1) {
        val viewport = state.layoutInfo.viewportEndOffset - state.layoutInfo.viewportStartOffset
        state.scrollToItem(count - 1, (last.size - viewport).coerceAtLeast(0))
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ConversationMessage(
    message: MobileMessage,
    detail: MobileMessageDetail?,
    markdownCache: MobileMarkdownCache,
    onRendered: () -> Unit,
    onMessageAction: (JSONObject) -> Unit,
    onResource: (JSONObject) -> Unit,
    onLoadDetail: (JSONObject) -> Unit,
) {
    val user = message.role == "user"
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (user) Arrangement.End else Arrangement.Start) {
        if (user) Spacer(Modifier.width(32.dp))
        Column(
            modifier = Modifier.weight(1f, fill = false)
                .then(if (user) Modifier.background(MaterialTheme.colorScheme.primaryContainer, PaintedShape).padding(horizontal = 16.dp, vertical = 12.dp) else Modifier)
                .combinedClickable(onClick = {}, onLongClick = { onMessageAction(message.source) }),
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (!user) Text(message.source.optJSONObject("author")?.optString("name")?.takeIf { it.isNotBlank() } ?: mobileText(R.string.mobile_assistant), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            val text = detail?.text ?: message.text
            val openFile = { detail?.resource?.let(onResource) ?: onLoadDetail(message.source) }
            if (text.isNotBlank()) {
                if (user) Text(text, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onPrimaryContainer)
                else MobileMarkdown(text, markdownCache, onOpenFile = openFile, onRendered = onRendered)
            }
            if (message.interrupted) Text(mobileText(R.string.mobile_this_reply_did_not_complete), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
            if (message.needsDetail || detail != null) DetailAccess(message, detail, onLoadDetail, onResource)
            ResourceLinks(message.resources, onResource)
        }
    }
}

@Composable
private fun ToolMessage(
    message: MobileMessage,
    detail: MobileMessageDetail?,
    expanded: Boolean,
    onExpanded: (Boolean) -> Unit,
    onMessageAction: (JSONObject) -> Unit,
    onResource: (JSONObject) -> Unit,
    onLoadDetail: (JSONObject) -> Unit,
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        ToolHeader(MobileMessagePresentation.toolTitle(message.toolName), expanded, message.toolError, onLongClick = { onMessageAction(message.source) }) {
            onExpanded(!expanded)
            if (!expanded && message.needsDetail && detail == null) onLoadDetail(message.source)
        }
        if (expanded) {
            Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, shape = RoundedCornerShape(12.dp)) {
                Column(Modifier.padding(14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    val text = detail?.text ?: message.text
                    if (text.isNotBlank()) {
                        if (MobileMessagePresentation.canCopy(text)) SelectionContainer { Text(text, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace) }
                        else Text(text, style = MaterialTheme.typography.bodySmall, fontFamily = FontFamily.Monospace)
                    } else if (!message.needsDetail) {
                        Text(if (message.toolError) mobileText(R.string.mobile_tool_call_failed_without_details) else mobileText(R.string.mobile_completed_without_text_output), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (message.toolError) Text(mobileText(R.string.mobile_tool_call_failed), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
                    if (message.needsDetail || detail != null) DetailAccess(message, detail, onLoadDetail, onResource)
                    ResourceLinks(message.resources, onResource)
                }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ToolHeader(title: String, expanded: Boolean, failed: Boolean, onLongClick: (() -> Unit)? = null, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().combinedClickable(onClick = onClick, onLongClick = onLongClick).padding(vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(if (failed) Icons.Outlined.WarningAmber else Icons.Outlined.Terminal, contentDescription = if (failed) mobileText(R.string.mobile_tool_call_failed) else null, tint = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(17.dp))
        Spacer(Modifier.width(8.dp))
        Text(title, Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, color = if (failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        Icon(if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore, contentDescription = if (expanded) mobileText(R.string.mobile_collapse_tool_details) else mobileText(R.string.mobile_expand_tool_details), modifier = Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun DetailAccess(message: MobileMessage, detail: MobileMessageDetail?, onLoadDetail: (JSONObject) -> Unit, onResource: (JSONObject) -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (message.truncated) Text(mobileText(R.string.mobile_the_message_preview_is_incomplete_refer_to_the_saved), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        when {
            detail?.loading == true -> Row(verticalAlignment = Alignment.CenterVertically) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text(if (message.truncated) mobileText(R.string.mobile_loading_saved_content) else mobileText(R.string.mobile_loading_content), style = MaterialTheme.typography.labelMedium)
            }
            detail?.error != null -> Column {
                Text(detail.error, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                TextButton(onClick = { onLoadDetail(message.source) }) { Text(mobileText(R.string.label_retry)) }
            }
            detail?.notice != null -> Text(detail.notice, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            detail?.text == null -> TextButton(onClick = { onLoadDetail(message.source) }, contentPadding = PaddingValues(0.dp)) { Text(if (message.truncated) mobileText(R.string.mobile_load_saved_content) else mobileText(R.string.mobile_view_full_content)) }
            detail.text.isEmpty() -> Text(mobileText(R.string.mobile_no_text_content), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (detail?.resource != null && (detail.notice != null || detail.error != null)) {
            TextButton(onClick = { onResource(detail.resource) }, contentPadding = PaddingValues(0.dp)) { Text(mobileText(R.string.mobile_preview_save_or_share)) }
        }
    }
}

@Composable
private fun ResourceLinks(resources: List<JSONObject>, onResource: (JSONObject) -> Unit) {
    resources.forEach { resource ->
        val label = MobileReadingPolicy.resource(resource)
        Surface(
            onClick = { onResource(resource) },
            enabled = label.available,
            modifier = Modifier.fillMaxWidth(),
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            shape = MaterialTheme.shapes.small,
        ) {
            Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Icon(Icons.Outlined.InsertDriveFile, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(24.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(label.name, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text("${label.type} · ${label.size}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    label.status?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
                if (label.available) Icon(Icons.Outlined.ChevronRight, contentDescription = mobileText(R.string.mobile_open_attachment), tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
            }
        }
    }
}
