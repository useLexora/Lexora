package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.font.FontWeight
import app.uselexora.mobile.protocol.ExecutionSettings
import org.json.JSONObject

@Composable
internal fun ConversationSettings(state: MobileUiState, onAction: (MobileAction, JSONObject?) -> Unit, openDownloads: (() -> Unit)? = null, close: () -> Unit) {
    BackHandler { if (state.executionPickerOpen) state.executionPickerOpen = false else close() }
    Surface(Modifier.fillMaxSize().testTag("conversation-settings"), color = MaterialTheme.colorScheme.background) {
        Column {
            SettingsHeader(mobileText(R.string.label_task_settings), mobileText(R.string.back_conversation), close)
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 12.dp)) {
                val hasMembers = state.selectedTask != null && state.membersSupported
                Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
                    Column {
                        Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text(state.selectedTask?.let(::taskTitle) ?: mobileText(R.string.label_new_task),
                                style = MaterialTheme.typography.titleMedium.copy(fontSize = 18.sp, lineHeight = 26.sp, fontWeight = FontWeight.Medium))
                            Text(if (state.selectedTask == null) state.spaceLabel else state.selectedTaskSpaceLabel,
                                Modifier.widthIn(max = 240.dp).testTag("task-space"), maxLines = 1, overflow = TextOverflow.Ellipsis,
                                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        val dividerColor = MaterialTheme.colorScheme.outlineVariant
                        HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = dividerColor.copy(alpha = dividerColor.alpha * 0.7f))
                        SettingsRow(mobileText(R.string.label_permissions), executionIcon(state.executionSelection),
                            value = state.executionLabel, tag = "execution", divider = hasMembers) { onAction(MobileAction.ChooseExecution, null) }
                        if (hasMembers) SettingsRow(mobileText(R.string.mobile_task_members), desktopSymbol(DesktopSymbol.Partners), tag = "task-partners", divider = false) { onAction(MobileAction.ShowMembers, null) }
                    }
                }
                if (openDownloads != null) {
                    Spacer(Modifier.height(16.dp))
                    DownloadsSettingsRow(openDownloads)
                }
            }
        }
    }
}

@Composable
private fun ExecutionSettingsPage(state: MobileUiState, onAction: (MobileAction, JSONObject?) -> Unit, modifier: Modifier = Modifier) {
    val target = pickerTarget(state)
    var confirmFullAccess by remember(target, state.executionSelection.toString()) { mutableStateOf(false) }
    Column(modifier.verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = 8.dp).selectableGroup(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        for (mode in ExecutionSettings.modes) {
            val current = mode.matches(state.executionSelection)
            Surface(shape = RoundedCornerShape(16.dp), color = if (current) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer) {
                Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("permission-${mode.profile}-${mode.policy}")
                    .selectable(selected = current, enabled = state.executionEnabled, role = Role.RadioButton) {
                        if (pickerTarget(state) == target && state.executionEnabled && !current) {
                            if (mode.profile == "full_access") confirmFullAccess = true
                            else onAction(MobileAction.ApplyExecution, mode.config())
                        }
                    }.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(executionIcon(mode.config()), null, Modifier.size(22.dp))
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f)) {
                        Text(mode.label, style = MaterialTheme.typography.bodyLarge)
                        Text(mode.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (current) Icon(Icons.Outlined.Check, null, Modifier.padding(start = 8.dp).size(20.dp))
                }
            }
        }
        if (!state.executionEnabled) Text(mobileText(R.string.mobile_permissions_unavailable), Modifier.testTag("permission-unavailable"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    if (confirmFullAccess) AlertDialog(
        onDismissRequest = { confirmFullAccess = false },
        title = { Text(mobileText(R.string.label_allow_full_access_alternate)) },
        text = { Text(mobileText(R.string.label_allows_file_access_and_commands_with_the_host_account_s_permissions_with_automatic_ap), Modifier.verticalScroll(rememberScrollState())) },
        dismissButton = { TextButton(onClick = { confirmFullAccess = false }, modifier = Modifier.testTag("cancel-full-access")) { Text(mobileText(R.string.label_cancel)) } },
        confirmButton = {
            TextButton(enabled = state.executionEnabled, modifier = Modifier.testTag("confirm-full-access"), onClick = {
                if (pickerTarget(state) == target && state.executionEnabled) {
                    confirmFullAccess = false
                    onAction(MobileAction.ApplyExecution, ExecutionSettings.modes.first { it.profile == "full_access" }.config())
                }
            }) { Text(mobileText(R.string.label_allow_full_access)) }
        },
    )
}

internal fun pickerTarget(state: MobileUiState) = listOf(state.devices.firstOrNull { it.selected }?.id, state.topic, state.selectedTask?.optString("id"), state.viewBranchId)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ConversationPermissionPicker(state: MobileUiState, onAction: (MobileAction, JSONObject?) -> Unit) {
    ModalBottomSheet(onDismissRequest = { state.executionPickerOpen = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxWidth().heightIn(max = LocalConfiguration.current.screenHeightDp.dp * .9f).testTag("permission-picker")) {
            Row(Modifier.fillMaxWidth().padding(start = 28.dp, end = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(mobileText(R.string.label_permissions_alternate), Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                IconButton(onClick = { state.executionPickerOpen = false }, modifier = Modifier.testTag("close-permission-picker")) { Icon(Icons.Outlined.Close, mobileText(R.string.review_close)) }
            }
            ExecutionSettingsPage(state, onAction, Modifier.weight(1f, fill = false))
        }
    }
}
