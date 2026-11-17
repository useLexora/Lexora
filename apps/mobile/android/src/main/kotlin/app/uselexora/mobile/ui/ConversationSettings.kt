package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import app.uselexora.mobile.protocol.ExecutionSettings
import org.json.JSONObject

@Composable
internal fun ConversationSettings(state: MobileUiState, onAction: (MobileAction, JSONObject?) -> Unit, close: () -> Unit, branches: () -> Unit, questions: () -> Unit, approvals: () -> Unit, runs: () -> Unit, phoneSettings: () -> Unit, members: () -> Unit = {}) {
    BackHandler { if (state.executionPickerOpen) state.executionPickerOpen = false else close() }
    Surface(Modifier.fillMaxSize().testTag("conversation-settings"), color = MaterialTheme.colorScheme.background) {
        Column {
            SettingsHeader(
                mobileText(R.string.label_task_settings),
                mobileText(R.string.back_conversation),
            ) { close() }
            LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
                item {
                    Column(Modifier.padding(horizontal = 16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(state.selectedTask?.let(::taskTitle) ?: mobileText(R.string.label_new_task), style = MaterialTheme.typography.titleLarge)
                        Text(state.deviceLabel, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                item { SettingsSection(mobileText(R.string.label_current_task)) {
                    if (state.selectedTask != null) SettingsRow(mobileText(R.string.label_branches), Icons.Outlined.AccountTree, branchLabel(state, state.viewBranchId.orEmpty()), kind = SettingsRowKind.Selection, tag = "current-branch", action = branches)
                    SettingsRow(mobileText(R.string.label_task_space), Icons.Outlined.FolderOpen, if (state.selectedTask == null) state.spaceLabel else state.selectedTaskSpaceLabel,
                        kind = if (state.selectedTask == null) SettingsRowKind.Selection else SettingsRowKind.ReadOnly, enabled = state.spaceEnabled) { onAction(MobileAction.ChooseSpace, null) }
                    SettingsRow(mobileText(R.string.label_permissions), Icons.Outlined.Shield, state.executionLabel, enabled = state.executionEnabled, tag = "execution", divider = state.selectedTask != null) { onAction(MobileAction.ChooseExecution, null) }
                    if (state.selectedTask != null && state.membersSupported) SettingsRow(mobileText(R.string.mobile_task_members), Icons.Outlined.Group, action = members)
                    if (state.selectedTask != null) SettingsRow(mobileText(R.string.label_task_files), Icons.Outlined.FolderOpen, divider = false) { onAction(MobileAction.Files, null) }
                } }
                if (state.selectedTask != null) item { SettingsSection(mobileText(R.string.label_progress_history)) {
                    if (state.questionsSupported) SettingsRow(mobileText(R.string.label_questions_answers), Icons.Outlined.ChatBubbleOutline, action = questions)
                    SettingsRow(mobileText(R.string.label_approval_history), Icons.Outlined.FactCheck, action = { onAction(MobileAction.Approvals, null) })
                    if (activeRuns(state).isNotEmpty()) SettingsRow(mobileText(R.string.label_running), Icons.Outlined.StopCircle, action = runs)
                    SettingsRow(mobileText(R.string.label_queued_messages), Icons.Outlined.PlaylistPlay, tag = "task-queue") { onAction(MobileAction.TaskQueue, null) }
                    if (state.hasInput) SettingsRow(mobileText(R.string.label_queue_current_input), Icons.Outlined.PlaylistAdd, kind = SettingsRowKind.Action, tag = "queue-input") { onAction(MobileAction.QueueInput, null) }
                    SettingsRow(mobileText(R.string.label_read_status), Icons.Outlined.DoneAll) { onAction(MobileAction.ReadState, null) }
                    SettingsRow(mobileText(R.string.label_earlier_messages), Icons.Outlined.History) { onAction(MobileAction.MoreHistory, null) }
                    SettingsRow(mobileText(R.string.label_open_on_desktop), Icons.Outlined.OpenInNew, kind = SettingsRowKind.Action, divider = false) { onAction(MobileAction.OpenOnDesktop, null) }
                } }
                item { SettingsSection(mobileText(R.string.label_connection_history)) {
                    SettingsRow(state.deviceLabel, Icons.Outlined.Dns, state.connectionLabel,
                        kind = if (state.connected) SettingsRowKind.ReadOnly else SettingsRowKind.Action) { onAction(MobileAction.Reconnect, null) }
                    SettingsRow(mobileText(R.string.label_send_history), Icons.Outlined.Send) { onAction(MobileAction.Outbox, null) }
                    SettingsRow(mobileText(R.string.label_local_drafts), Icons.Outlined.EditNote) { onAction(MobileAction.Recovery, null) }
                    SettingsRow(mobileText(R.string.label_refresh_task), Icons.Outlined.Refresh, kind = SettingsRowKind.Action, divider = false) { onAction(MobileAction.Refresh, null) }
                } }
                item { SettingsSection(mobileText(R.string.mobile_phone_settings)) {
                    SettingsRow(mobileText(R.string.label_appearance_language), Icons.Outlined.Palette, divider = false, action = phoneSettings)
                } }
            }
        }
    }
}

@Composable
private fun ExecutionSettingsPage(state: MobileUiState, onAction: (MobileAction, JSONObject?) -> Unit, modifier: Modifier = Modifier) {
    val target = pickerTarget(state)
    var confirmFullAccess by remember(target, state.executionSelection.toString()) { mutableStateOf(false) }
    Column(modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(mobileText(R.string.permissions_summary, state.executionLabel), style = MaterialTheme.typography.titleSmall)
        Text(mobileText(R.string.mobile_permissions_apply_immediately), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        for (mode in ExecutionSettings.modes) {
            val current = mode.matches(state.executionSelection)
            Surface(shape = RoundedCornerShape(16.dp), color = if (current) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer) {
                Row(Modifier.fillMaxWidth().testTag("permission-${mode.profile}-${mode.policy}").semantics { selected = current }
                    .clickable(enabled = state.executionEnabled, role = Role.RadioButton) {
                        if (pickerTarget(state) == target && state.executionEnabled && !current) {
                            if (mode.profile == "full_access") confirmFullAccess = true
                            else onAction(MobileAction.ApplyExecution, mode.config())
                        }
                    }.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(if (mode.profile == "full_access") Icons.Outlined.LockOpen else Icons.Outlined.Shield, null, Modifier.size(22.dp))
                    Spacer(Modifier.width(12.dp))
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text(mode.label, style = MaterialTheme.typography.bodyLarge)
                        Text(mode.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (current) Icon(Icons.Outlined.Check, mobileText(R.string.label_selected), Modifier.padding(start = 8.dp).size(20.dp))
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

private fun pickerTarget(state: MobileUiState) = listOf(state.devices.firstOrNull { it.selected }?.id, state.topic, state.selectedTask?.optString("id"), state.viewBranchId)

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun ConversationModelPicker(state: MobileUiState, onAction: (MobileAction, JSONObject?) -> Unit) {
    val target = pickerTarget(state)
    var query by remember(target) { mutableStateOf("") }
    var selection by remember(target) { mutableStateOf(if (state.modelPickerShowList) null else MobileModelControls.model(state.modelSelection, state.models)) }
    var reasoning by remember(target) { mutableStateOf(state.modelSelection?.opt("reasoning") as? String) }
    var tier by remember(target) { mutableStateOf(state.modelSelection?.opt("serviceTier") as? String) }
    val heightLimit = LocalConfiguration.current.screenHeightDp.dp * .8f
    ModalBottomSheet(onDismissRequest = { state.modelPickerOpen = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxWidth().heightIn(max = heightLimit).padding(horizontal = 20.dp).testTag("model-picker")) {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                if (selection != null) IconButton(onClick = { selection = null }) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, mobileText(R.string.label_back_to_models)) }
                Text(if (selection == null) mobileText(R.string.label_choose_model) else selection!!.optString("displayName"), style = MaterialTheme.typography.titleLarge, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                IconButton(onClick = { state.modelPickerOpen = false }, modifier = Modifier.testTag("close-model-picker")) { Icon(Icons.Outlined.Close, mobileText(R.string.label_close_model_picker)) }
            }
            val model = selection?.let { MobileModelControls.model(it, state.models) ?: it }
            if (model == null) {
                OutlinedTextField(query, { query = it }, modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp).testTag("model-search"), singleLine = true, placeholder = { Text(mobileText(R.string.label_search_models)) }, leadingIcon = { Icon(Icons.Outlined.Search, null) }, trailingIcon = {
                    if (query.isNotEmpty()) IconButton(onClick = { query = "" }, modifier = Modifier.testTag("clear-model-search")) { Icon(Icons.Outlined.Close, mobileText(R.string.mobile_clear_model_search)) }
                }, shape = RoundedCornerShape(14.dp))
                if (state.modelsLoading) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (state.modelsError.isNotEmpty()) TextButton(onClick = { onAction(MobileAction.ChooseModel, null) }) { Text((state.modelsError)) }
                LazyColumn(Modifier.weight(1f, fill = false).testTag("model-list"), contentPadding = PaddingValues(bottom = 24.dp)) {
                    val models = state.models.filter { it.optString("displayName").contains(query, true) || it.optString("modelId").contains(query, true) || it.optString("providerId").contains(query, true) }
                    if (!state.modelsLoading && state.modelsError.isEmpty() && models.isEmpty()) item { Text(mobileText(R.string.label_no_matching_models), Modifier.padding(vertical = 24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    items(models, key = { it.optString("providerId") + ":" + it.optString("modelId") }) { candidate ->
                        ActionRow(candidate.optString("displayName"), Icons.Outlined.AutoAwesome, "${candidate.optString("providerId")} · ${candidate.optString("modelId")}", tag = "model-option:${candidate.optString("providerId")}:${candidate.optString("modelId")}", checked = state.modelSelection?.optString("modelId") == candidate.optString("modelId") && state.modelSelection?.optString("providerId") == candidate.optString("providerId")) {
                            selection = candidate
                            val current = state.modelSelection?.takeIf { it.optString("modelId") == candidate.optString("modelId") && it.optString("providerId") == candidate.optString("providerId") }
                            reasoning = MobileModelControls.resolve(current ?: JSONObject().put("modelId", candidate.getString("modelId")).put("providerId", candidate.getString("providerId")), state.models).opt("reasoning") as? String; tier = current?.opt("serviceTier") as? String
                        }
                    }
                }
            } else {
                Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(vertical = 20.dp).testTag("model-parameters"), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                    Text(model.optString("displayName"), style = MaterialTheme.typography.titleMedium)
                    ActionRow(mobileText(R.string.label_change_model), Icons.Outlined.AutoAwesome, "${model.optString("providerId")} · ${model.optString("modelId")}", tag = "change-model") { selection = null }
                    val reasons = model.optJSONArray("reasoningOptions")
                    if (reasons != null && reasons.length() > 0) Column {
                        Text(mobileText(R.string.label_reasoning_effort), style = MaterialTheme.typography.titleSmall)
                        FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            for (index in 0 until reasons.length()) {
                                val value = reasons.getString(index)
                                val label = MobileModelControls.reasoningLabel(value)
                                FilterChip(selected = reasoning == value, onClick = { reasoning = value }, label = { Text(label) })
                            }
                        }
                    }
                    if (MobileModelControls.supportsFast(model, state.models)) {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(mobileText(R.string.fast_mode), style = MaterialTheme.typography.titleSmall)
                                Text(mobileText(R.string.label_priority_processing), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Switch(checked = tier == "priority", onCheckedChange = { tier = if (it) "priority" else null }, modifier = Modifier.testTag("fast-mode").semantics { contentDescription = mobileText(R.string.label_fast_priority_processing) })
                        }
                    }
                }
                Text(mobileText(R.string.mobile_model_apply_explicit), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Button(enabled = state.configEnabled && state.inputEnabled && MobileModelControls.model(model, state.models) != null,
                    onClick = {
                        if (pickerTarget(state) == target && state.configEnabled && state.inputEnabled) {
                            onAction(MobileAction.ApplyModel, MobileModelControls.parameters(model, reasoning, tier))
                        }
                    }, modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp).heightIn(min = 48.dp).testTag("apply-model"), shape = RoundedCornerShape(14.dp)) { Text(mobileText(R.string.label_use_this_model)) }
            }
        }
    }
}

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
