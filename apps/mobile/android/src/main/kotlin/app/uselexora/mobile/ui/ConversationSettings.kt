package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.horizontalScroll
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
internal fun ConversationSettings(state: MobileUiState, onAction: (MobileAction, JSONObject?) -> Unit, close: () -> Unit, branches: () -> Unit, questions: () -> Unit, approvals: () -> Unit, runs: () -> Unit) {
    BackHandler { if (state.executionPickerOpen) state.executionPickerOpen = false else close() }
    Surface(Modifier.fillMaxSize().testTag("conversation-settings"), color = MaterialTheme.colorScheme.background) {
        Column {
            Row(Modifier.fillMaxWidth().height(56.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { if (state.executionPickerOpen) state.executionPickerOpen = false else close() }) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, if (state.executionPickerOpen) mobileText(R.string.back_task_settings) else mobileText(R.string.back_conversation)) }
                Text(if (state.executionPickerOpen) mobileText(R.string.label_permissions) else mobileText(R.string.label_task_settings), style = MaterialTheme.typography.titleMedium)
            }
            if (state.executionPickerOpen) ExecutionSettingsPage(state, onAction)
            else LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                item { SettingsSection(mobileText(R.string.label_current_task)) {
                    if (state.selectedTask != null) ActionRow(mobileText(R.string.label_branches), Icons.Outlined.AccountTree, branchLabel(state, state.viewBranchId.orEmpty()), tag = "current-branch", action = branches)
                    ActionRow(mobileText(R.string.label_task_space), Icons.Outlined.FolderOpen, if (state.selectedTask == null) state.spaceLabel else state.selectedTaskSpaceLabel, enabled = state.selectedTask == null && state.spaceEnabled) { onAction(MobileAction.ChooseSpace, null) }
                    ActionRow(mobileText(R.string.label_permissions), Icons.Outlined.Shield, (state.executionLabel), enabled = state.executionEnabled, tag = "execution") { state.executionPickerOpen = true }
                    if (state.selectedTask != null) ActionRow(mobileText(R.string.label_task_files), Icons.Outlined.FolderOpen) { onAction(MobileAction.Files, null) }
                } }
                if (state.selectedTask != null) item { SettingsSection(mobileText(R.string.label_progress_history)) {
                    if (state.questionsSupported) ActionRow(mobileText(R.string.label_questions_answers), Icons.Outlined.ChatBubbleOutline, action = questions)
                    ActionRow(mobileText(R.string.label_approval_history), Icons.Outlined.FactCheck, action = { onAction(MobileAction.Approvals, null) })
                    if (activeRuns(state).isNotEmpty()) ActionRow(mobileText(R.string.label_running), Icons.Outlined.StopCircle, action = runs)
                    ActionRow(mobileText(R.string.label_queued_messages), Icons.Outlined.PlaylistPlay, tag = "task-queue") { onAction(MobileAction.TaskQueue, null) }
                    if (state.hasInput) ActionRow(mobileText(R.string.label_queue_current_input), Icons.Outlined.PlaylistAdd, tag = "queue-input") { onAction(MobileAction.QueueInput, null) }
                    ActionRow(mobileText(R.string.label_read_status), Icons.Outlined.DoneAll) { onAction(MobileAction.ReadState, null) }
                    ActionRow(mobileText(R.string.label_earlier_messages), Icons.Outlined.History) { onAction(MobileAction.MoreHistory, null) }
                    ActionRow(mobileText(R.string.label_open_on_desktop), Icons.Outlined.OpenInNew) { onAction(MobileAction.OpenOnDesktop, null) }
                } }
                item { SettingsSection(mobileText(R.string.label_connection_history)) {
                    ActionRow(state.deviceLabel, Icons.Outlined.Dns, if (state.connected) mobileText(R.string.label_connected) else mobileText(R.string.label_disconnected), enabled = !state.connected) { onAction(MobileAction.Reconnect, null) }
                    ActionRow(mobileText(R.string.label_send_history), Icons.Outlined.Send) { onAction(MobileAction.Outbox, null) }
                    ActionRow(mobileText(R.string.label_local_drafts), Icons.Outlined.EditNote) { onAction(MobileAction.Recovery, null) }
                    ActionRow(mobileText(R.string.label_refresh_task), Icons.Outlined.Refresh) { onAction(MobileAction.Refresh, null) }
                } }
            }
        }
    }
}

@Composable
private fun SettingsSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column {
        Text(title, Modifier.padding(start = 12.dp, bottom = 8.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainer) { Column(Modifier.padding(4.dp), content = content) }
    }
}

@Composable
private fun ExecutionSettingsPage(state: MobileUiState, onAction: (MobileAction, JSONObject?) -> Unit, modifier: Modifier = Modifier) {
    var confirmFullAccess by remember { mutableStateOf(false) }
    LazyColumn(modifier, contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        items(ExecutionSettings.modes) { mode ->
            Surface(shape = RoundedCornerShape(16.dp), color = if (mode.matches(state.executionSelection)) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer) {
                ActionRow((mode.label), if (mode.profile == "full_access") Icons.Outlined.LockOpen else Icons.Outlined.Shield, (mode.description), checked = mode.matches(state.executionSelection), enabled = state.executionEnabled) {
                    if (mode.profile == "full_access" && !mode.matches(state.executionSelection)) confirmFullAccess = true
                    else onAction(MobileAction.ApplyExecution, mode.config())
                }
            }
        }
        if (confirmFullAccess) item {
            Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.errorContainer) {
                Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text(mobileText(R.string.label_allow_full_access_alternate), style = MaterialTheme.typography.titleMedium)
                    Text(mobileText(R.string.label_allows_file_access_and_commands_with_the_host_account_s_permissions_with_automatic_ap), style = MaterialTheme.typography.bodyMedium)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TextButton(onClick = { confirmFullAccess = false }) { Text(mobileText(R.string.label_cancel)) }
                        Button(onClick = { onAction(MobileAction.ApplyExecution, ExecutionSettings.modes.first { it.profile == "full_access" }.config()) }) { Text(mobileText(R.string.label_allow_full_access)) }
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ConversationModelPicker(state: MobileUiState, onAction: (MobileAction, JSONObject?) -> Unit) {
    var query by remember { mutableStateOf("") }
    var selection by remember { mutableStateOf(if (state.modelPickerShowList) null else MobileModelControls.model(state.modelSelection, state.models)) }
    var reasoning by remember { mutableStateOf(state.modelSelection?.opt("reasoning") as? String) }
    var tier by remember { mutableStateOf(state.modelSelection?.opt("serviceTier") as? String) }
    ModalBottomSheet(onDismissRequest = { state.modelPickerOpen = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(.8f).padding(horizontal = 20.dp).testTag("model-picker")) {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                if (selection != null) IconButton(onClick = { selection = null }) { Icon(Icons.AutoMirrored.Outlined.ArrowBack, mobileText(R.string.label_back_to_models)) }
                Text(if (selection == null) mobileText(R.string.label_choose_model) else selection!!.optString("displayName"), style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                IconButton(onClick = { state.modelPickerOpen = false }) { Icon(Icons.Outlined.Close, mobileText(R.string.label_close_model_picker)) }
            }
            val model = selection
            if (model == null) {
                OutlinedTextField(query, { query = it }, modifier = Modifier.fillMaxWidth().padding(vertical = 12.dp), singleLine = true, placeholder = { Text(mobileText(R.string.label_search_models)) }, leadingIcon = { Icon(Icons.Outlined.Search, null) }, shape = RoundedCornerShape(14.dp))
                if (state.modelsLoading) LinearProgressIndicator(Modifier.fillMaxWidth())
                if (state.modelsError.isNotEmpty()) TextButton(onClick = { onAction(MobileAction.ChooseModel, null) }) { Text((state.modelsError)) }
                LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(bottom = 24.dp)) {
                    val models = state.models.filter { it.optString("displayName").contains(query, true) || it.optString("modelId").contains(query, true) }
                    if (!state.modelsLoading && state.modelsError.isEmpty() && models.isEmpty()) item { Text(mobileText(R.string.label_no_matching_models), Modifier.padding(vertical = 24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    items(models, key = { it.optString("providerId") + ":" + it.optString("modelId") }) { candidate ->
                        ActionRow(candidate.optString("displayName"), Icons.Outlined.AutoAwesome, candidate.optString("modelId"), checked = state.modelSelection?.optString("modelId") == candidate.optString("modelId") && state.modelSelection?.optString("providerId") == candidate.optString("providerId")) {
                            selection = candidate
                            val current = state.modelSelection?.takeIf { it.optString("modelId") == candidate.optString("modelId") && it.optString("providerId") == candidate.optString("providerId") }
                            reasoning = MobileModelControls.resolve(current ?: JSONObject().put("modelId", candidate.getString("modelId")).put("providerId", candidate.getString("providerId")), state.models).opt("reasoning") as? String; tier = current?.opt("serviceTier") as? String
                        }
                    }
                }
            } else {
                LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(vertical = 20.dp), verticalArrangement = Arrangement.spacedBy(20.dp)) {
                    item { ActionRow(mobileText(R.string.label_change_model), Icons.Outlined.AutoAwesome, model.optString("modelId")) { selection = null } }
                    val reasons = model.optJSONArray("reasoningOptions")
                    if (reasons != null && reasons.length() > 0) item {
                        Text(mobileText(R.string.label_reasoning_effort), style = MaterialTheme.typography.titleSmall)
                        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            for (index in 0 until reasons.length()) {
                                val value = reasons.getString(index)
                                val label = MobileModelControls.reasoningLabel(value)
                                FilterChip(selected = reasoning == value, onClick = { reasoning = value }, label = { Text(label) })
                            }
                        }
                    }
                    if (MobileModelControls.supportsFast(model, state.models)) item {
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(mobileText(R.string.fast_mode), style = MaterialTheme.typography.titleSmall)
                                Text(mobileText(R.string.label_priority_processing), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            Switch(checked = tier == "priority", onCheckedChange = { tier = if (it) "priority" else null }, modifier = Modifier.testTag("fast-mode").semantics { contentDescription = mobileText(R.string.label_fast_priority_processing) })
                        }
                    }
                }
                Button(onClick = { onAction(MobileAction.ApplyModel, JSONObject().put("providerId", model.getString("providerId")).put("modelId", model.getString("modelId")).put("reasoning", reasoning ?: JSONObject.NULL).put("serviceTier", tier ?: JSONObject.NULL)) }, modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(bottom = 8.dp), shape = RoundedCornerShape(14.dp)) { Text(mobileText(R.string.label_use_this_model)) }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ConversationPermissionPicker(state: MobileUiState, onAction: (MobileAction, JSONObject?) -> Unit) {
    ModalBottomSheet(onDismissRequest = { state.executionPickerOpen = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(.8f).testTag("permission-picker")) {
            Text(mobileText(R.string.label_permissions_alternate), Modifier.padding(horizontal = 28.dp, vertical = 8.dp), style = MaterialTheme.typography.titleLarge)
            ExecutionSettingsPage(state, onAction, Modifier.weight(1f))
        }
    }
}
