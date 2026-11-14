package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileQuantity
import app.uselexora.mobile.i18n.mobileText
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.indication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.material3.ripple
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.uselexora.mobile.R
import org.json.JSONObject

private data class PaperPalette(val sheet: List<Color>, val folder: List<Color>, val ribbon: List<Color>, val rule: Color)

@Composable
private fun paperPalette(): PaperPalette = if (MaterialTheme.colorScheme.background.luminance() < .5f) {
    PaperPalette(listOf(Color(0xFF33303D), Color(0xFF26232E)), listOf(Color(0xFF47414F), Color(0xFF36313F)), listOf(Color(0xFF65517E), Color(0xFF57456D)), Color(0xFF82718F))
} else {
    PaperPalette(listOf(Color.White, Color(0xFFEEE9F4)), listOf(Color(0xFFF9F5FD), Color(0xFFE6DEEF)), listOf(Color(0xFFE5D9F6), Color(0xFFD4C4EC)), Color(0xFFC7B9DB))
}

@Composable
internal fun PaperWorkbench(
    state: MobileUiState,
    tasks: List<JSONObject>,
    onAction: (MobileAction, JSONObject?) -> Unit,
    devices: () -> Unit,
    settings: () -> Unit,
    tools: () -> Unit = {},
) {
    val palette = paperPalette()
    var connectionPrompt by remember { mutableStateOf(false) }
    fun connectedAction(action: MobileAction, payload: JSONObject? = null) {
        if (state.connected) onAction(action, payload) else connectionPrompt = true
    }
    val filter: (MobileTaskFilter) -> Unit = { connectedAction(MobileAction.ShowTaskFilter, JSONObject().put("filter", it.name)) }
    LaunchedEffect(state.connected) { if (state.connected) connectionPrompt = false }
    if (connectionPrompt) PaperConnectionPrompt(palette, { connectionPrompt = false }) {
        connectionPrompt = false
        if (state.devices.isEmpty()) onAction(MobileAction.ScanDevice, null) else devices()
    }
    fun count(value: MobileTaskFilter) = taskFilterCount(tasks, value, state.tasksLoaded, state.markedTaskIds, state.marksLoaded)
    LazyColumn(
        state = rememberLazyListState(),
        modifier = Modifier.fillMaxSize().testTag("workbench-list"),
        contentPadding = PaddingValues(start = 24.dp, end = 24.dp, top = 16.dp, bottom = 32.dp),
    ) {
        item {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                val avatarInteraction = remember { MutableInteractionSource() }
                Box(Modifier.size(48.dp).clickable(interactionSource = avatarInteraction, indication = null, role = Role.Button, onClick = tools).semantics { contentDescription = mobileText(R.string.label_workspace_options) }, contentAlignment = Alignment.CenterStart) {
                    Image(painterResource(R.mipmap.ic_lexora), null, Modifier.size(32.dp).testTag("workbench-avatar-surface").clip(RoundedCornerShape(9.dp)).indication(avatarInteraction, ripple()))
                }
                Spacer(Modifier.weight(1f))
                PaperToolButton(Icons.Outlined.Tune, mobileText(R.string.label_appearance_language), palette, onClick = settings)
                Spacer(Modifier.width(8.dp))
                PaperToolButton(Icons.Outlined.Search, mobileText(R.string.label_search_tasks), palette, folded = true) { connectedAction(MobileAction.ShowTasks) }
            }
            Spacer(Modifier.height(8.dp))
            PaperServiceBar(state, palette, devices) { onAction(MobileAction.ChooseSpaceFilter, null) }
            Spacer(Modifier.height(16.dp))
        }
        item { NewTaskPaper { connectedAction(MobileAction.NewTask) } }
        item {
            Spacer(Modifier.height(44.dp))
            Box(Modifier.fillMaxWidth().padding(bottom = 12.dp)) {
                PaperSurface(RoundedCornerShape(14.dp), Modifier.matchParentSize().offset(y = 9.dp).rotate(2f), palette.sheet, 3.dp) {}
                PaperSurface(RoundedCornerShape(14.dp), Modifier.fillMaxWidth(), palette.sheet, 5.dp) {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp).padding(bottom = 24.dp)) {
                        Row(Modifier.fillMaxWidth().offset(y = (-14).dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.Top) {
                            FolderAction(mobileText(R.string.label_approvals), count(MobileTaskFilter.Approvals), R.plurals.approval_tasks, "home-approvals", palette, Modifier.weight(1f)) { filter(MobileTaskFilter.Approvals) }
                            FolderAction(mobileText(R.string.question_answers), count(MobileTaskFilter.Questions), R.plurals.question_tasks, "home-questions", palette, Modifier.weight(1f).padding(top = 24.dp)) { filter(MobileTaskFilter.Questions) }
                        }
                        Spacer(Modifier.height(12.dp))
                        PaperShortcut(mobileText(R.string.label_unread), count(MobileTaskFilter.Unread), R.plurals.unread_tasks, "home-unread", Icons.Outlined.Inbox, palette.ribbon, RoundedCornerShape(10.dp)) { filter(MobileTaskFilter.Unread) }
                        Spacer(Modifier.height(16.dp))
                        PaperShortcut(mobileText(R.string.label_marked), count(MobileTaskFilter.Marked), R.plurals.marked_tasks, "home-marked", Icons.Outlined.BookmarkBorder, palette.sheet, PaperBookmarkShape) { filter(MobileTaskFilter.Marked) }
                    }
                }
            }
        }
        item {
            when {
                state.taskSyncFailed -> HomeStatus(mobileText(R.string.label_sync_failed_showing_previously_loaded_tasks), mobileText(R.string.label_retry)) { onAction(MobileAction.Refresh, null) }
                !state.tasksLoaded && state.connected -> HomeStatus(mobileText(R.string.label_syncing_tasks), null) { onAction(MobileAction.Reconnect, null) }
                !state.connected && state.tasksLoaded -> HomeStatus(mobileText(R.string.label_service_offline_showing_previously_synced_tasks), mobileText(R.string.label_reconnect)) { onAction(MobileAction.Reconnect, null) }
                state.marksFailed -> HomeStatus(mobileText(R.string.label_task_marks_could_not_sync_please_retry), mobileText(R.string.label_retry)) { onAction(MobileAction.Refresh, null) }
            }
            if ((state.outboxCount ?: 0) > 0) HomeStatus(mobileQuantity(R.plurals.mobile_send_records_awaiting_confirmation, state.outboxCount ?: 0), mobileText(R.string.label_view_history)) { onAction(MobileAction.Outbox, null) }
        }
    }
}

@Composable
private fun PaperServiceBar(state: MobileUiState, palette: PaperPalette, devices: () -> Unit, spaces: () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxWidth().testTag("service-status-bar")) {
        val detailWidth = maxWidth * if (state.connected) .48f else .54f
        val serviceInteraction = remember { MutableInteractionSource() }
        Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Box(
                Modifier.weight(1f).heightIn(min = 48.dp)
                    .testTag("service-selector")
                    .semantics { contentDescription = listOf(state.deviceLabel, state.connectionLabel).joinToString(" · ") }
                    .clickable(interactionSource = serviceInteraction, indication = null, role = Role.Button, onClick = devices),
                contentAlignment = Alignment.CenterStart,
            ) {
                Row(Modifier.testTag("service-selector-surface").clip(RoundedCornerShape(6.dp)).indication(serviceInteraction, ripple()).padding(horizontal = 4.dp, vertical = 6.dp),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    ServiceIcon(Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(state.deviceLabel, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val statusColor = when {
                        state.connected -> MaterialTheme.colorScheme.secondary
                        state.connectionPhase != app.uselexora.mobile.session.MobileConnectionPhase.Idle -> MaterialTheme.colorScheme.tertiary
                        else -> MaterialTheme.colorScheme.outline
                    }
                    Box(Modifier.size(6.dp).clip(androidx.compose.foundation.shape.CircleShape).background(statusColor))
                }
            }
            if (state.connected) {
                val interaction = remember { MutableInteractionSource() }
                val shape = RoundedCornerShape(topStart = 5.dp, topEnd = 9.dp, bottomEnd = 3.dp, bottomStart = 3.dp)
                Box(
                    Modifier.widthIn(max = detailWidth).heightIn(min = 48.dp).testTag("space-filter")
                        .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = spaces),
                    contentAlignment = Alignment.Center,
                ) {
                    PaperSurface(shape, Modifier.testTag("space-filter-surface"), colors = palette.sheet) {
                        Row(Modifier.clip(shape).indication(interaction, ripple()).padding(horizontal = 10.dp, vertical = 7.dp), verticalAlignment = Alignment.CenterVertically) {
                            Text(if (state.selectedSpaceId == null) mobileText(R.string.label_all_spaces) else state.selectedSpaceLabel, Modifier.weight(1f, fill = false), fontSize = 12.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Spacer(Modifier.width(7.dp))
                            Icon(Icons.Outlined.ExpandMore, null, Modifier.size(13.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            } else Text(
                (state.connectionLabel),
                Modifier.widthIn(max = detailWidth).padding(vertical = 8.dp).testTag("connection-detail")
                    .semantics { liveRegion = androidx.compose.ui.semantics.LiveRegionMode.Polite },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = androidx.compose.ui.text.style.TextAlign.End,
            )
        }
    }
}

@Composable
private fun PaperConnectionPrompt(palette: PaperPalette, dismiss: () -> Unit, connect: () -> Unit) {
    Dialog(onDismissRequest = dismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Box(Modifier.fillMaxWidth().padding(horizontal = 24.dp), contentAlignment = Alignment.Center) {
            PaperSurface(PaperFoldShape(22.dp), Modifier.widthIn(max = 380.dp).fillMaxWidth(), palette.sheet, 6.dp) {
                Column(Modifier.padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Box(Modifier.size(48.dp), contentAlignment = Alignment.Center) {
                        PaperSurface(RoundedCornerShape(11.dp), Modifier.matchParentSize(), palette.folder, 1.dp) {}
                        Icon(Icons.Outlined.Link, null, Modifier.size(26.dp), tint = MaterialTheme.colorScheme.primary)
                    }
                    Text(mobileText(R.string.connection_not_connected), style = MaterialTheme.typography.titleLarge, color = MaterialTheme.colorScheme.onSurface)
                    Text(mobileText(R.string.label_connect_to_a_lexora_service_to_start_tasks_and_follow_progress), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Row(Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        TextButton(onClick = dismiss, modifier = Modifier.weight(1f).heightIn(min = 48.dp)) { Text(mobileText(R.string.label_later)) }
                        PaperSurface(RoundedCornerShape(9.dp), Modifier.weight(1f).heightIn(min = 48.dp), palette.ribbon, 2.dp, onClick = connect) {
                            Box(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 14.dp), contentAlignment = Alignment.Center) {
                                Text(mobileText(R.string.label_connect_service), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurface)
                            }
                        }
                    }
                }
                PaperCurl(Modifier.size(23.dp).align(Alignment.BottomEnd))
            }
        }
    }
}

@Composable
private fun PaperToolButton(icon: ImageVector, label: String, palette: PaperPalette, folded: Boolean = false, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Box(Modifier.size(48.dp).semantics { contentDescription = label }.clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick), contentAlignment = Alignment.CenterEnd) {
        PaperSurface(RoundedCornerShape(6.dp), Modifier.size(38.dp).testTag(if (folded) "workbench-search-surface" else "workbench-settings-surface"), palette.sheet, 1.dp) {
            Box(Modifier.fillMaxSize().clip(RoundedCornerShape(6.dp)).indication(interaction, ripple())) {
                Icon(icon, null, Modifier.size(20.dp).align(Alignment.Center), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                if (folded) PaperCurl(Modifier.size(9.dp).align(Alignment.TopEnd).rotate(-90f))
            }
        }
    }
}

@Composable
private fun NewTaskPaper(onClick: () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxWidth()) {
        val narrow = maxWidth < 320.dp
        PaperSurface(
            PaperFoldShape(28.dp),
            Modifier.fillMaxWidth().heightIn(min = if (narrow) 166.dp else 182.dp).testTag("new-task"),
            listOf(Color(0xFF8256D8), Color(0xFF7548CD), Color(0xFF603BB9)), 5.dp, onClick = onClick,
        ) {
            Row(Modifier.fillMaxWidth().align(Alignment.Center).padding(horizontal = if (narrow) 20.dp else 25.dp, vertical = 28.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(mobileText(R.string.label_new_task), fontSize = if (narrow) 30.sp else 34.sp, lineHeight = 42.sp, fontWeight = FontWeight.SemiBold, color = Color.White)
                    Text(mobileText(R.string.label_describe_your_goal_let_lexora_handle_it), fontSize = 13.sp, lineHeight = 20.sp, color = Color(0xFFF6F2FF))
                }
                PaperArrowStack(Modifier.size(if (narrow) 61.dp else 74.dp, if (narrow) 70.dp else 84.dp))
            }
            PaperCurl(Modifier.size(30.dp).align(Alignment.BottomEnd))
        }
    }
}

@Composable
private fun FolderAction(label: String, count: Int?, meaning: Int, tag: String, palette: PaperPalette, modifier: Modifier, onClick: () -> Unit) {
    PaperSurface(
        PaperFolderShape,
        modifier.heightIn(min = 140.dp).testTag(tag).semantics { stateDescription = count?.let { mobileQuantity(meaning, it) } ?: mobileText(R.string.label_count_unavailable) },
        palette.folder, 5.dp, onClick = onClick,
    ) {
        Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 29.dp, bottom = 18.dp), verticalArrangement = Arrangement.spacedBy(13.dp)) {
            Text(label, Modifier.fillMaxWidth(), fontSize = 18.sp, lineHeight = 26.sp, fontWeight = FontWeight.SemiBold)
            HorizontalDivider(color = palette.rule.copy(alpha = .7f), thickness = .5.dp)
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(count?.toString() ?: "—", Modifier.weight(1f), fontSize = 32.sp, lineHeight = 36.sp, fontWeight = FontWeight.Normal)
                Icon(Icons.Outlined.ChevronRight, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun PaperShortcut(label: String, count: Int?, meaning: Int, tag: String, icon: ImageVector, colors: List<Color>, shape: androidx.compose.ui.graphics.Shape, onClick: () -> Unit) {
    PaperSurface(shape, Modifier.fillMaxWidth().heightIn(min = 58.dp).testTag(tag).semantics { stateDescription = count?.let { mobileQuantity(meaning, it) } ?: mobileText(R.string.label_count_unavailable) }, colors, 3.dp, onClick = onClick) {
        Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 14.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(10.dp))
            Text(label, Modifier.weight(1f), fontSize = 16.sp, fontWeight = FontWeight.Medium)
            Text(count?.toString() ?: "—", fontSize = 23.sp, lineHeight = 28.sp)
            Spacer(Modifier.width(10.dp))
            Icon(Icons.Outlined.ChevronRight, null, Modifier.size(17.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun HomeStatus(text: String, action: String?, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (action != null) TextButton(onClick = onClick, modifier = Modifier.heightIn(min = 48.dp)) { Text(action) }
    }
}
