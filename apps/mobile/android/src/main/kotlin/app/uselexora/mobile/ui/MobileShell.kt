package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.MobileStrings
import app.uselexora.mobile.i18n.mobileQuantity
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import android.icu.text.RelativeDateTimeFormatter
import android.view.Gravity
import android.view.ViewGroup
import android.widget.EditText
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.ArrowForward
import androidx.compose.material.icons.automirrored.outlined.ListAlt
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.saveable.rememberSaveableStateHolder
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.viewinterop.AndroidView
import org.json.JSONObject
import java.time.Instant

private enum class MobileSheet { Workbench, Task, TaskMore, Queue, Attachments, InputSettings, Devices, Questions, Approvals, Runs, Branches }

@OptIn(ExperimentalMaterial3Api::class, ExperimentalComposeUiApi::class)
@Composable
fun MobileShell(
    state: MobileUiState,
    composer: EditText,
    onAction: (MobileAction, JSONObject?) -> Unit,
    timeline: @Composable (Modifier) -> Unit,
) {
    var sheet by remember { mutableStateOf<MobileSheet?>(null) }
    var appearanceSettings by remember { mutableStateOf(false) }
    var taskSettings by remember { mutableStateOf(false) }
    val savedPages = rememberSaveableStateHolder()
    val conversation = state.screen == MobileScreen.Conversation
    val deviceId = state.devices.firstOrNull { it.selected }?.id.orEmpty()
    val act: (MobileAction) -> Unit = { if (it == MobileAction.TaskBranches) sheet = MobileSheet.Branches; onAction(it, null) }
    val tasks = remember(state.tasks, state.selectedSpaceId) { scopedTasks(state.tasks, state.selectedSpaceId) }
    LaunchedEffect(state.screen, deviceId, state.topic) { sheet = null; taskSettings = false; state.modelPickerOpen = false; state.executionPickerOpen = false; state.messageMenu = null }
    BackHandler(state.screen != MobileScreen.Workbench && sheet == null && !taskSettings && !state.modelPickerOpen) { act(MobileAction.Back) }
    BoxWithConstraints(
        Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }
            .background(MaterialTheme.colorScheme.background).safeDrawingPadding().imePadding(),
    ) {
        val tightInput = conversation && maxHeight < 240.dp
        val inputMaxHeight = if (tightInput) (maxHeight - 100.dp).coerceIn(44.dp, 168.dp) else (maxHeight * 0.24f).coerceIn(48.dp, 168.dp)
        Column(Modifier.fillMaxSize()) {
            if (!tightInput && state.screen != MobileScreen.Workbench) ShellHeader(state, act, devices = { sheet = MobileSheet.Devices }) {
                if (conversation) {
                    taskSettings = true
                    (composer.context.getSystemService(android.content.Context.INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager).hideSoftInputFromWindow(composer.windowToken, 0)
                } else sheet = MobileSheet.Workbench
            }
            val connectionNotice = !state.connected && state.notice == MobileFailurePresentation.NETWORK_UNAVAILABLE_NOTICE
            if (!tightInput && state.notice.isNotBlank() && !connectionNotice) Notice(state.notice) { act(MobileAction.DismissNotice) }
            if (!tightInput && !state.connected && state.screen != MobileScreen.Workbench) Text(
                (state.connectionLabel), style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
            )
            if (!tightInput && conversation && state.readingCached) Text(
                if (state.connected) mobileText(R.string.mobile_showing_phone_content_updating) else mobileText(R.string.mobile_phone_content_connect_to_update),
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
            )
            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (conversation) {
                    if (state.selectedTask == null && state.messages.isEmpty()) NewTaskIntro(state, act)
                    else timeline(Modifier.fillMaxSize())
                } else {
                    savedPages.SaveableStateProvider("$deviceId:${state.screen}:${state.selectedSpaceId ?: "all"}:${state.taskFilter}") {
                        when (state.screen) {
                            MobileScreen.Workbench -> PaperWorkbench(state, tasks, onAction, devices = { sheet = MobileSheet.Devices }, settings = { appearanceSettings = true }, tools = { sheet = MobileSheet.Workbench })
                            MobileScreen.Spaces -> SpaceList(state, onAction)
                            MobileScreen.Tasks -> TaskList(state, tasks, onAction)
                            MobileScreen.Devices -> DeviceList(state, onAction)
                            MobileScreen.Conversation -> Unit
                        }
                    }
                }
            }
            if (conversation) {
                if (tightInput) CompactConversationActions(state, onAction, { sheet = MobileSheet.Attachments }, { sheet = MobileSheet.Questions }, { sheet = MobileSheet.Approvals })
                else ConversationActions(state, onAction, { sheet = MobileSheet.Questions }, { sheet = MobileSheet.Approvals })
                ComposerBar(state, composer, onAction, inputMaxHeight, tightInput, { sheet = MobileSheet.Attachments }, { sheet = MobileSheet.Runs })
            }
        }
        if (taskSettings) ConversationSettings(state, { action, payload -> if (action == MobileAction.Files) taskSettings = false; onAction(action, payload) }, { taskSettings = false },
            branches = { sheet = MobileSheet.Branches; act(MobileAction.TaskBranches) },
            questions = { sheet = MobileSheet.Questions }, approvals = { sheet = MobileSheet.Approvals }, runs = { sheet = MobileSheet.Runs })
    }
    state.taskFiles?.let { TaskFilesPanel(it, onAction) { state.taskFiles = null } }
    if (appearanceSettings) AppearanceSettings { appearanceSettings = false }
    if (state.executionPickerOpen && !taskSettings) ConversationPermissionPicker(state, onAction)
    if (state.modelPickerOpen) ConversationModelPicker(state, onAction)
    state.messageMenu?.let { ConversationMessageMenu(it, state.connected, onAction) { state.messageMenu = null } }
    if (sheet == MobileSheet.Devices) ServiceSwitcher(state, onAction) { sheet = null }
    else sheet?.let { current ->
        ModalBottomSheet(
            onDismissRequest = { sheet = null },
            containerColor = MaterialTheme.colorScheme.surfaceContainer,
            sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        ) {
            LazyColumn(modifier = Modifier.semantics { testTagsAsResourceId = true }, contentPadding = PaddingValues(start = 12.dp, end = 12.dp, bottom = 24.dp)) {
                item {
                    Text(
                        when (current) {
                            MobileSheet.Workbench -> mobileText(R.string.label_workspace_options)
                            MobileSheet.Task -> mobileText(R.string.mobile_task_options)
                            MobileSheet.TaskMore -> mobileText(R.string.more_options)
                            MobileSheet.Queue -> mobileText(R.string.label_queued_messages)
                            MobileSheet.Branches -> mobileText(R.string.label_branches)
                            MobileSheet.Attachments -> mobileText(R.string.label_add_to_input)
                            MobileSheet.InputSettings -> mobileText(R.string.label_input_settings)
                            MobileSheet.Devices -> mobileText(R.string.label_switch_service)
                            MobileSheet.Questions -> mobileText(R.string.label_needs_your_answer)
                            MobileSheet.Approvals -> mobileText(R.string.label_needs_your_approval)
                            MobileSheet.Runs -> mobileText(R.string.label_choose_a_run_to_stop)
                        },
                        style = MaterialTheme.typography.titleLarge,
                        modifier = Modifier.padding(12.dp, 4.dp, 12.dp, 16.dp),
                    )
                }
                when (current) {
                    MobileSheet.Branches -> {
                        if (state.branchesLoading && state.branches.isEmpty()) item { Text(mobileText(R.string.label_loading_branches), Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        if (state.branchesFailed) item { ActionRow(mobileText(R.string.label_could_not_load_branches_tap_to_retry), Icons.Outlined.Refresh) { act(MobileAction.TaskBranches) } }
                        items(state.branches, key = { it.getString("id") }) { branch ->
                            val progress = buildList {
                                if (branch.optInt("runningCount") > 0) add(mobileQuantity(R.plurals.mobile_runs, branch.optInt("runningCount")))
                                if (branch.optInt("pendingQuestionCount") > 0) add(mobileQuantity(R.plurals.mobile_questions, branch.optInt("pendingQuestionCount")))
                                if (branch.optInt("pendingApprovalCount") > 0) add(mobileQuantity(R.plurals.mobile_pending_confirmations, branch.optInt("pendingApprovalCount")))
                                if (branch.optInt("queuedCount") > 0) add(mobileQuantity(R.plurals.mobile_queued_inputs, branch.optInt("queuedCount")))
                            }
                            ActionRow(branchLabel(state, branch.getString("id")), Icons.Outlined.AccountTree,
                                subtitle = (progress + listOfNotNull(branchCreatedLabel(branch))).takeIf { it.isNotEmpty() }?.joinToString(" · "),
                                checked = branch.optString("id") == state.viewBranchId,
                                tag = "branch:${branch.getString("id")}") {
                                sheet = null; onAction(MobileAction.SelectBranch, branch)
                            }
                        }
                    }
                    MobileSheet.Questions -> items(state.questions.sortedByDescending { it.optString("createdAt") }, key = { it.getString("id") }) { question ->
                        ActionRow(questionSummary(question), Icons.Outlined.ChatBubbleOutline, subtitle = listOfNotNull(questionStateLabel(question), question.optString("buddyName").takeIf { it.isNotBlank() }).joinToString(" · ")) {
                            sheet = null; onAction(MobileAction.AnswerQuestion, question)
                        }
                    }
                    MobileSheet.Approvals -> items(state.approvalItems.filter { it.optString("status") == "pending" }, key = { it.getString("id") }) { approval ->
                        ActionRow(approval.optString("summary"), Icons.Outlined.FactCheck) { sheet = null; onAction(MobileAction.ReviewApproval, approval) }
                    }
                    MobileSheet.Runs -> items(activeRuns(state), key = { it.getString("id") }) { run ->
                        ActionRow(if (run.optString("status") == "queued") mobileText(R.string.label_queued_run) else mobileText(R.string.label_running), Icons.Outlined.StopCircle,
                            subtitle = runStartedLabel(run), enabled = state.connected && state.stoppingRunId != run.optString("id")) {
                            sheet = null; onAction(MobileAction.StopRun, run)
                        }
                    }
                    MobileSheet.Devices -> {
                        items(state.devices, key = { it.id }) { device ->
                            ActionRow(device.label, Icons.Outlined.Dns, subtitle = if (device.selected) state.connectionLabel else device.address, checked = device.selected) {
                                sheet = null
                                onAction(MobileAction.SelectDevice, JSONObject().put("id", device.id))
                            }
                        }
                        item { ActionRow(mobileText(R.string.label_scan_to_connect_alternate), Icons.Outlined.QrCodeScanner) { sheet = null; act(MobileAction.ScanDevice) } }
                        if (state.devices.isNotEmpty()) {
                            item { ActionRow(mobileText(R.string.label_manage_services), Icons.Outlined.Settings) { sheet = null; act(MobileAction.ShowDevices) } }
                            if (!state.connected && state.devices.any { it.selected }) item { ActionRow(mobileText(R.string.label_reconnect), Icons.Outlined.Refresh) { sheet = null; act(MobileAction.Reconnect) } }
                        }
                    }
                    MobileSheet.Attachments -> {
                        if (state.attachments.isNotEmpty()) {
                            item { Text(mobileText(R.string.label_added), Modifier.padding(12.dp), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            items(state.attachments, key = { it.id }) { attachment ->
                                val payload = JSONObject().put("id", attachment.id)
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    ActionRow(attachment.name, Icons.Outlined.AttachFile, subtitle = attachment.stateLabel, modifier = Modifier.weight(1f)) { sheet = null; onAction(MobileAction.OpenAttachment, payload) }
                                    if (attachment.canRemove) IconButton(onClick = { onAction(MobileAction.RemoveAttachment, payload) }, enabled = state.inputEnabled, modifier = Modifier.size(48.dp)) { Icon(Icons.Outlined.Close, mobileText(R.string.mobile_remove_attachment, attachment.name), Modifier.size(18.dp)) }
                                }
                            }
                        }
                        items(sheetEntries(current, state), key = { it.title }) { entry -> ActionRow(entry.title, entry.icon) { sheet = null; entry.action?.let(act) } }
                    }
                    MobileSheet.InputSettings -> {
                        item {
                            ActionRow(mobileText(R.string.label_model), Icons.Outlined.AutoAwesome, modelLabel(state), enabled = state.configEnabled && state.inputEnabled, tag = "model") {
                                sheet = null; act(MobileAction.ChooseModel)
                            }
                        }
                        item {
                            ActionRow(mobileText(R.string.label_permissions), Icons.Outlined.Tune, state.executionLabel, enabled = state.executionEnabled, tag = "execution") {
                                sheet = null; act(MobileAction.ChooseExecution)
                            }
                        }
                        if (state.selectedTask == null && state.spaceVisible) item {
                            ActionRow(mobileText(R.string.label_task_space), Icons.Outlined.FolderOpen, state.spaceLabel, enabled = state.spaceEnabled, tag = "space") {
                                sheet = null; act(MobileAction.ChooseSpace)
                            }
                        }
                    }
                    else -> {
                        items(sheetEntries(current, state), key = { it.title }) { entry ->
                            ActionRow(entry.title, entry.icon) {
                                if (entry.next != null) sheet = entry.next
                                else { sheet = null; entry.action?.let(act) }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ShellHeader(state: MobileUiState, act: (MobileAction) -> Unit, devices: () -> Unit, more: () -> Unit) {
    val root = state.screen == MobileScreen.Workbench
    val conversation = state.screen == MobileScreen.Conversation
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(start = if (root) 20.dp else 4.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (!root) IconButton(onClick = { act(MobileAction.Back) }, modifier = Modifier.size(48.dp)) {
            Icon(Icons.AutoMirrored.Outlined.ArrowBack, mobileText(R.string.label_back))
        }
        Column(Modifier.weight(1f).padding(vertical = 5.dp)) {
            Box {
                if (root) BrushMark(Modifier.align(Alignment.BottomStart).width(58.dp).height(7.dp))
                Text(
                    when (state.screen) {
                        MobileScreen.Workbench -> mobileText(R.string.label_workspace)
                        MobileScreen.Spaces -> mobileText(R.string.label_spaces)
                        MobileScreen.Tasks -> taskFilterTitle(state.taskFilter)
                        MobileScreen.Devices -> mobileText(R.string.label_my_services)
                        MobileScreen.Conversation -> state.selectedTask?.let(::taskTitle) ?: mobileText(R.string.label_new_task)
                    },
                    style = if (root) MaterialTheme.typography.headlineMedium else MaterialTheme.typography.titleMedium,
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (conversation && state.selectedTask != null) TextButton(
            onClick = { act(MobileAction.TaskBranches) }, shape = RoundedCornerShape(6.dp),
            contentPadding = PaddingValues(horizontal = 8.dp),
            modifier = Modifier.widthIn(min = 48.dp).heightIn(min = 48.dp).testTag("branch-switcher").semantics { contentDescription = mobileText(R.string.label_branches) },
        ) {
            Icon(Icons.Outlined.ForkRight, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            if (state.branches.size > 1) {
                Spacer(Modifier.width(4.dp))
                Text(state.branches.size.toString(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        if (conversation && state.selectedTask != null) IconButton(onClick = { act(MobileAction.Files) }, modifier = Modifier.size(48.dp).testTag("task-results")) {
            Icon(Icons.Outlined.FolderOpen, mobileText(R.string.label_task_files))
        }
        when (state.screen) {
            MobileScreen.Devices -> IconButton(onClick = { act(MobileAction.ScanDevice) }, modifier = Modifier.size(48.dp)) { Icon(Icons.Outlined.QrCodeScanner, mobileText(R.string.label_scan_to_add_service)) }
            MobileScreen.Tasks -> IconButton(onClick = { act(MobileAction.NewTask) }, modifier = Modifier.size(48.dp)) { Icon(Icons.Outlined.Add, mobileText(R.string.label_new_task)) }
            else -> IconButton(onClick = more, modifier = Modifier.size(48.dp)) { Icon(Icons.Outlined.Tune, if (conversation) mobileText(R.string.label_task_settings) else mobileText(R.string.label_workspace_options), Modifier.size(22.dp)) }
        }
    }
}

@Composable
private fun DeviceChip(state: MobileUiState, open: () -> Unit) {
    Row(
        Modifier.heightIn(min = 48.dp).widthIn(max = 148.dp).clip(MaterialTheme.shapes.small)
            .semantics { contentDescription = listOf(state.deviceLabel, state.connectionLabel).joinToString(" · ") }
            .clickable(role = Role.Button, onClick = open).padding(horizontal = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(5.dp).clip(RoundedCornerShape(3.dp)).background(if (state.connected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline))
        Spacer(Modifier.width(7.dp))
        Text(state.deviceLabel, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Icon(Icons.Outlined.ExpandMore, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun TaskList(state: MobileUiState, tasks: List<JSONObject>, onAction: (MobileAction, JSONObject?) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val filtered = remember(tasks, state.taskFilter, state.markedTaskIds) { tasks.filter { matchesTaskFilter(it, state.taskFilter, state.markedTaskIds) } }
    val matches = remember(filtered, query) { filtered.filter { query.isBlank() || taskTitle(it).contains(query.trim(), ignoreCase = true) || it.optString("previewText").contains(query.trim(), ignoreCase = true) } }
    val count = taskFilterCount(tasks, state.taskFilter, state.tasksLoaded, state.markedTaskIds, state.marksLoaded)
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 20.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { onAction(MobileAction.ChooseSpaceFilter, null) }, modifier = Modifier.heightIn(min = 48.dp).testTag("space-filter")) {
                Text(state.selectedSpaceLabel, style = MaterialTheme.typography.labelMedium)
                Icon(Icons.Outlined.ExpandMore, null, Modifier.size(16.dp))
            }
            Spacer(Modifier.weight(1f))
            if (count != null) Text(mobileQuantity(R.plurals.mobile_tasks, count), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (state.taskFilter == MobileTaskFilter.Marked && state.marksFailed) Text(mobileText(R.string.mobile_mark_sync_failed_previously_loaded_results_are_retained), Modifier.padding(horizontal = 20.dp, vertical = 8.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (filtered.isNotEmpty() || query.isNotEmpty() || state.taskFilter == MobileTaskFilter.All) {
            OutlinedTextField(
                value = query, onValueChange = { query = it }, singleLine = true,
                placeholder = { Text(mobileText(R.string.label_search_tasks)) }, leadingIcon = { Icon(Icons.Outlined.Search, null, Modifier.size(20.dp)) },
                trailingIcon = if (query.isNotEmpty()) ({ IconButton(onClick = { query = "" }) { Icon(Icons.Outlined.Close, mobileText(R.string.label_clear_search), Modifier.size(18.dp)) } }) else null,
                textStyle = MaterialTheme.typography.bodyMedium, shape = MaterialTheme.shapes.medium,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 12.dp),
                colors = OutlinedTextFieldDefaults.colors(unfocusedBorderColor = MaterialTheme.colorScheme.outlineVariant),
            )
        }
        if (matches.isEmpty()) {
            if (query.isNotEmpty()) EmptyPane(mobileText(R.string.label_task_not_found), mobileText(R.string.label_try_another_part_of_the_title_or_message))
            else if (!state.tasksLoaded || state.taskFilter == MobileTaskFilter.All) TaskEmptyState(state, onAction)
            else if (count == null) EmptyPane(mobileText(R.string.mobile_not_loaded, taskFilterTitle(state.taskFilter)), mobileText(R.string.mobile_connect_to_the_service_and_sync_to_view_this), mobileText(R.string.label_refresh)) { onAction(MobileAction.Refresh, null) }
            else EmptyPane(mobileText(R.string.mobile_no_yet, taskFilterTitle(state.taskFilter)), mobileText(R.string.mobile_new_content_will_appear_here_you_can_also_switch))
        } else LazyColumn(state = rememberLazyListState(), modifier = Modifier.fillMaxSize().testTag("task-list"), contentPadding = PaddingValues(bottom = 24.dp)) {
            items(matches, key = { it.getString("id") }) { task ->
                when (state.taskFilter) {
                    MobileTaskFilter.Approvals -> TaskRow(task, state.spaces, onClick = { onAction(MobileAction.OpenTask, task) }, confirmLabel = mobileText(R.string.label_review), confirm = { onAction(MobileAction.ReviewTaskApproval, task) })
                    MobileTaskFilter.Questions -> TaskRow(task, state.spaces, onClick = { onAction(MobileAction.OpenTaskQuestions, task) }, confirmLabel = mobileText(R.string.question_answers), confirm = { onAction(MobileAction.OpenTaskQuestions, task) })
                    MobileTaskFilter.Unread -> if ((task.opt("resultBranchId") as? String)?.isNotBlank() == true) {
                        TaskRow(task, state.spaces, onClick = { onAction(MobileAction.OpenTask, task) }, confirmLabel = mobileText(R.string.label_view_result), confirm = { onAction(MobileAction.OpenTaskResult, task) })
                    } else TaskRow(task, state.spaces, onClick = { onAction(MobileAction.OpenTask, task) })
                    else -> TaskRow(task, state.spaces, onClick = { onAction(MobileAction.OpenTask, task) })
                }
            }
        }
    }
}

@Composable
private fun SpaceList(state: MobileUiState, onAction: (MobileAction, JSONObject?) -> Unit) {
    if (state.devices.isEmpty()) {
        EmptyPane(mobileText(R.string.label_keep_your_spaces_with_you), mobileText(R.string.mobile_connect_to_find_tasks_in_your_desktop_spaces), mobileText(R.string.label_connect_service)) { onAction(MobileAction.ScanDevice, null) }
        return
    }
    LazyColumn(state = rememberLazyListState(), modifier = Modifier.fillMaxSize().testTag("space-list"), contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp)) {
        item { SpaceRow(mobileText(R.string.label_all_tasks), state.tasks.size.takeIf { state.tasksLoaded }, Icons.AutoMirrored.Outlined.ListAlt) { onAction(MobileAction.OpenSpace, JSONObject().put("id", JSONObject.NULL).put("name", mobileText(R.string.label_all_spaces))) } }
        item { SpaceRow(mobileText(R.string.label_no_space), state.tasks.count { taskSpaceId(it) == null }.takeIf { state.tasksLoaded }, Icons.Outlined.FolderOpen) { onAction(MobileAction.OpenSpace, JSONObject().put("id", "").put("name", mobileText(R.string.label_no_space))) } }
        item { SectionHeading(mobileText(R.string.label_spaces_on_your_service)) }
        if (state.spaces.isEmpty()) item {
            Text(
                if (state.connected) mobileText(R.string.mobile_spaces_created_on_the_desktop_will_appear_here) else mobileText(R.string.label_connect_to_a_service_to_load_spaces),
                Modifier.padding(horizontal = 20.dp, vertical = 12.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        items(state.spaces, key = { it.getString("id") }) { space ->
            SpaceRow(space.optString("name"), state.tasks.count { taskSpaceId(it) == space.optString("id") }.takeIf { state.tasksLoaded }, Icons.Outlined.FolderOpen) {
                onAction(MobileAction.OpenSpace, JSONObject().put("id", space.getString("id")).put("name", space.optString("name")))
            }
        }
    }
}

@Composable
private fun SpaceRow(name: String, count: Int?, icon: ImageVector, open: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 72.dp).clickable(role = Role.Button, onClick = open).padding(horizontal = 20.dp, vertical = 16.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.width(14.dp))
        Text(name, Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
        if (count != null) Text(count.toString(), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(10.dp))
        Icon(Icons.Outlined.ChevronRight, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.outline)
    }
    RowDivider()
}

@Composable
private fun TaskRow(task: JSONObject, spaces: List<JSONObject>, onClick: () -> Unit, confirmLabel: String = mobileText(R.string.label_confirm), confirm: (() -> Unit)? = null) {
    val activity = task.optString("activity")
    val status = when (activity) {
        "running" -> mobileText(R.string.label_in_progress)
        "awaiting_approval" -> mobileText(R.string.label_needs_approval)
        else -> when (task.optString("lastRunStatus")) { "failed" -> mobileText(R.string.label_run_failed); "cancelled" -> mobileText(R.string.label_stopped); else -> null }
    }
    val preview = (task.opt("previewText") as? String)?.replace(Regex("\\s+"), " ")?.trim()?.takeIf { it.isNotEmpty() }
    val details = listOfNotNull(taskSpaceLabel(task, spaces), if (task.optInt("pendingQuestionCount") > 0) mobileText(R.string.label_needs_an_answer) else null, status, preview).joinToString(" · ")
    Row(
        Modifier.fillMaxWidth().heightIn(min = 72.dp).clickable(role = Role.Button, onClick = onClick).padding(horizontal = 20.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(taskTitle(task), Modifier.weight(1f), style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (task.optBoolean("unread")) { Spacer(Modifier.width(8.dp)); Box(Modifier.size(6.dp).clip(RoundedCornerShape(3.dp)).background(MaterialTheme.colorScheme.primary)) }
                if (confirm == null) taskTime(task)?.let {
                    Spacer(Modifier.width(10.dp)); Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Text(details, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (confirm != null) {
            Spacer(Modifier.width(12.dp))
            TextButton(onClick = confirm, modifier = Modifier.heightIn(min = 48.dp)) { Text(confirmLabel) }
        }
    }
    RowDivider()
}

@Composable
private fun SectionHeading(title: String, actionLabel: String? = null, action: () -> Unit = {}) {
    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).padding(start = 20.dp, end = 12.dp, top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, Modifier.weight(1f), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (actionLabel != null) TextButton(onClick = action, modifier = Modifier.heightIn(min = 48.dp)) { Text(actionLabel, style = MaterialTheme.typography.labelMedium); Icon(Icons.Outlined.ChevronRight, null, Modifier.size(16.dp)) }
    }
}

@Composable
private fun OutboxNotice(count: Int, open: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).clickable(role = Role.Button, onClick = open).padding(horizontal = 20.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Outlined.Send, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
        Spacer(Modifier.width(12.dp))
        Text(mobileQuantity(R.plurals.mobile_operation_results_awaiting_confirmation, count), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
        Icon(Icons.Outlined.ChevronRight, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.outline)
    }
}

@Composable
private fun TaskEmptyState(state: MobileUiState, onAction: (MobileAction, JSONObject?) -> Unit) {
    when {
        state.devices.isEmpty() -> EmptyPane(mobileText(R.string.label_continue_your_work_here), mobileText(R.string.mobile_connect_to_follow_task_progress_handle_confirmations_or_start), mobileText(R.string.label_connect_service)) { onAction(MobileAction.ScanDevice, null) }
        state.devices.none { it.selected } -> EmptyPane(mobileText(R.string.label_choose_a_service), mobileText(R.string.mobile_open_a_previously_connected_service_to_view_tasks_and), mobileText(R.string.label_choose_service)) { onAction(MobileAction.ShowDevices, null) }
        !state.tasksLoaded && !state.connected -> EmptyPane(mobileText(R.string.label_service_disconnected), mobileText(R.string.mobile_tasks_and_spaces_will_appear_when_the_connection_is), mobileText(R.string.label_reconnect)) { onAction(MobileAction.Reconnect, null) }
        !state.tasksLoaded && state.taskSyncFailed -> EmptyPane(mobileText(R.string.label_tasks_are_temporarily_unavailable), mobileText(R.string.mobile_still_connected_retry_loading_tasks), mobileText(R.string.label_retry)) { onAction(MobileAction.Refresh, null) }
        !state.tasksLoaded -> EmptyPane(mobileText(R.string.label_loading_tasks), mobileText(R.string.mobile_syncing_this_service_s_tasks_and_spaces))
        else -> EmptyPane(if (state.selectedSpaceId == null) mobileText(R.string.label_start_with_a_task) else mobileText(R.string.label_no_tasks_in_this_space_yet), mobileText(R.string.mobile_write_a_question_or_idea_lexora_will_send_it), mobileText(R.string.label_new_task)) { onAction(MobileAction.NewTask, null) }
    }
}

@Composable
private fun DeviceList(state: MobileUiState, onAction: (MobileAction, JSONObject?) -> Unit) {
    if (state.devices.isEmpty()) {
        EmptyPane(mobileText(R.string.label_connect_your_service), mobileText(R.string.mobile_scan_the_pairing_qr_code_on_lexora_desktop_each), mobileText(R.string.label_scan_to_connect)) { onAction(MobileAction.ScanDevice, null) }
    } else LazyColumn(state = rememberLazyListState(), contentPadding = PaddingValues(top = 8.dp, bottom = 24.dp)) {
        items(state.devices, key = { it.id }) { device ->
            val payload = JSONObject().put("id", device.id)
            Row(
                Modifier.fillMaxWidth().clickable(role = Role.Button) { onAction(MobileAction.SelectDevice, payload) }.padding(start = 20.dp, end = 4.dp, top = 16.dp, bottom = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.Dns, null, Modifier.size(24.dp), tint = if (device.selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(14.dp))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(device.label, style = MaterialTheme.typography.titleMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(device.address, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(when { device.connected -> mobileText(R.string.label_connected); device.selected -> state.connectionLabel; else -> device.lastConnectedLabel ?: mobileText(R.string.label_tap_to_connect) }, style = MaterialTheme.typography.labelMedium, color = if (device.connected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (device.selected) Icon(Icons.Outlined.Check, mobileText(R.string.label_current_service), Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
                IconButton(onClick = { onAction(MobileAction.ManageDevice, payload) }, modifier = Modifier.size(48.dp)) { Icon(Icons.Outlined.MoreHoriz, mobileText(R.string.mobile_manage, device.label)) }
            }
            RowDivider()
        }
        item { ActionRow(mobileText(R.string.label_add_another_service), Icons.Outlined.Add, modifier = Modifier.padding(horizontal = 8.dp)) { onAction(MobileAction.ScanDevice, null) } }
        if (state.connected) item { ActionRow(mobileText(R.string.label_disconnect), Icons.Outlined.LinkOff, modifier = Modifier.padding(horizontal = 8.dp)) { onAction(MobileAction.Disconnect, null) } }
    }
}

@Composable
private fun NewTaskIntro(state: MobileUiState, act: (MobileAction) -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 28.dp, vertical = 24.dp), verticalArrangement = Arrangement.Center) {
        PaperSurface(PaperFoldShape(18.dp), Modifier.size(64.dp), listOf(MaterialTheme.colorScheme.surfaceContainer, MaterialTheme.colorScheme.primaryContainer), 2.dp) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { Icon(Icons.Outlined.EditNote, null, Modifier.size(30.dp), tint = MaterialTheme.colorScheme.primary) }
        }
        Spacer(Modifier.height(24.dp))
        Text(mobileText(R.string.label_what_would_you_like_to_do), style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(10.dp))
        Text(mobileText(R.string.label_ask_a_question_or_attach_a_file), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (state.spaceVisible) {
            Spacer(Modifier.height(14.dp))
            TextButton(onClick = { act(MobileAction.ChooseSpace) }, enabled = state.spaceEnabled, contentPadding = PaddingValues(0.dp), modifier = Modifier.heightIn(min = 48.dp).testTag("space")) {
                Icon(Icons.Outlined.FolderOpen, null, Modifier.size(17.dp)); Spacer(Modifier.width(8.dp))
                Text(state.spaceLabel, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Icon(Icons.Outlined.ExpandMore, null, Modifier.size(16.dp))
            }
        }
    }
}

@Composable
private fun ConversationActions(state: MobileUiState, onAction: (MobileAction, JSONObject?) -> Unit, questions: () -> Unit, approvals: () -> Unit) {
    val pendingQuestions = if (state.questionsSupported) state.questions.filter { it.optString("status") == "pending" || it.optJSONObject("delivery")?.optString("state") == "failed" } else emptyList()
    val pendingApprovals = state.approvalItems.filter { it.optString("status") == "pending" }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp)) {
        if (state.queueItems.any { it.optString("status") == "queued" }) TextButton(onClick = { onAction(MobileAction.TaskQueue, null) }, modifier = Modifier.heightIn(min = 48.dp)) {
            Icon(Icons.Outlined.PlaylistPlay, null, Modifier.size(20.dp))
            Text(mobileQuantity(R.plurals.queued_inputs, state.queueItems.count { it.optString("status") == "queued" }), Modifier.padding(start = 8.dp))
        }
        pendingQuestions.firstOrNull()?.let { question ->
            ConversationPrompt(questionStateLabel(question), questionSummary(question), if (pendingQuestions.size > 1) mobileText(R.string.mobile_view, pendingQuestions.size) else questionActionLabel(question), MaterialTheme.colorScheme.primaryContainer, state.connected, "answer-question") {
                if (pendingQuestions.size > 1) questions() else onAction(MobileAction.AnswerQuestion, question)
            }
        }
        pendingApprovals.firstOrNull()?.let { approval ->
            ConversationPrompt(mobileText(R.string.label_needs_approval), approval.optString("summary"), mobileText(R.string.label_review), MaterialTheme.colorScheme.primaryContainer, state.connected, "review-approval") {
                if (pendingApprovals.size > 1) approvals() else onAction(MobileAction.ReviewApproval, approval)
            }
        }
    }
}

@Composable
private fun ConversationPrompt(title: String, summary: String, actionLabel: String, color: Color, enabled: Boolean, tag: String, action: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(bottom = 4.dp).background(color, PaintedShape).padding(start = 12.dp, end = 4.dp, top = 4.dp, bottom = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = MaterialTheme.typography.labelMedium)
            if (summary.isNotBlank()) Text(summary, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        TextButton(onClick = action, enabled = enabled, modifier = Modifier.heightIn(min = 48.dp).testTag(tag)) { Text(actionLabel) }
    }
}

@Composable
private fun CompactConversationActions(state: MobileUiState, onAction: (MobileAction, JSONObject?) -> Unit, attachments: () -> Unit, questions: () -> Unit, approvals: () -> Unit) {
    val pendingQuestions = if (state.questionsSupported) state.questions.filter { it.optString("status") == "pending" || it.optJSONObject("delivery")?.optString("state") == "failed" } else emptyList()
    val pendingApprovals = state.approvalItems.filter { it.optString("status") == "pending" }
    Row(Modifier.fillMaxWidth().height(48.dp).horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp).testTag("compact-context"), verticalAlignment = Alignment.CenterVertically) {
        if (state.attachments.isNotEmpty() || state.attachmentCount > 0) TextButton(onClick = attachments) { Text(mobileText(R.string.compact_attachments, maxOf(state.attachments.size, state.attachmentCount))) }
        if (pendingQuestions.isNotEmpty()) TextButton(onClick = { if (pendingQuestions.size == 1) onAction(MobileAction.AnswerQuestion, pendingQuestions.first()) else questions() }, enabled = state.connected) { Text(mobileText(R.string.compact_questions, pendingQuestions.size)) }
        if (pendingApprovals.isNotEmpty()) TextButton(onClick = { if (pendingApprovals.size == 1) onAction(MobileAction.ReviewApproval, pendingApprovals.first()) else approvals() }, enabled = state.connected) { Text(mobileText(R.string.compact_approvals, pendingApprovals.size)) }
        if (state.queueItems.any { it.optString("status") == "queued" }) TextButton(onClick = { onAction(MobileAction.TaskQueue, null) }) { Text(mobileText(R.string.compact_queued)) }
        if (state.selectedTask != null) TextButton(onClick = { onAction(MobileAction.Files, null) }) { Text(mobileText(R.string.label_task_files)) }
        if (state.attachments.isEmpty() && pendingQuestions.isEmpty() && pendingApprovals.isEmpty() && state.selectedTask == null) Text(mobileText(R.string.compact_new_draft), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun AttachmentStrip(state: MobileUiState, onAction: (MobileAction, JSONObject?) -> Unit) {
    if (state.attachments.isNotEmpty()) {
        LazyRow(horizontalArrangement = Arrangement.spacedBy(8.dp), contentPadding = PaddingValues(bottom = 8.dp), modifier = Modifier.fillMaxWidth().testTag("attachment-list")) {
            items(state.attachments, key = { it.id }) { attachment ->
                val payload = JSONObject().put("id", attachment.id)
                Row(Modifier.widthIn(min = 160.dp, max = 264.dp).background(MaterialTheme.colorScheme.secondaryContainer, PaintedShape), verticalAlignment = Alignment.CenterVertically) {
                    Row(
                        Modifier.weight(1f).heightIn(min = 64.dp).clickable(role = Role.Button) { onAction(MobileAction.OpenAttachment, payload) }.padding(start = 12.dp, end = 8.dp, top = 10.dp, bottom = 10.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Icon(when { attachment.mimeType.startsWith("image/") -> Icons.Outlined.Image; attachment.mimeType == "application/pdf" -> Icons.Outlined.PictureAsPdf; else -> Icons.Outlined.InsertDriveFile }, null, Modifier.size(21.dp), tint = MaterialTheme.colorScheme.onSecondaryContainer)
                        Spacer(Modifier.width(8.dp))
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                            Text(attachment.name, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSecondaryContainer, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            if (attachment.stateLabel.isNotBlank()) Text(attachment.stateLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSecondaryContainer, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                    }
                    if (attachment.canRemove) IconButton(onClick = { onAction(MobileAction.RemoveAttachment, payload) }, enabled = state.inputEnabled, modifier = Modifier.size(48.dp)) {
                        Icon(Icons.Outlined.Close, mobileText(R.string.mobile_remove_attachment, attachment.name), Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSecondaryContainer)
                    }
                }
            }
        }
    } else if (state.attachmentCount > 0) TextButton(onClick = { onAction(MobileAction.Files, null) }, modifier = Modifier.heightIn(min = 48.dp)) {
        Icon(Icons.Outlined.AttachFile, null, Modifier.size(17.dp)); Spacer(Modifier.width(6.dp)); Text(mobileQuantity(R.plurals.mobile_view_attachments, state.attachmentCount))
    }
}

@Composable
private fun ComposerBar(state: MobileUiState, composer: EditText, onAction: (MobileAction, JSONObject?) -> Unit, inputMaxHeight: Dp, tight: Boolean, attachments: () -> Unit, runs: () -> Unit) {
    val focused = remember(composer) { mutableStateOf(composer.hasFocus()) }
    DisposableEffect(composer) {
        val previous = composer.onFocusChangeListener
        val listener = android.view.View.OnFocusChangeListener { _, value -> focused.value = value }
        composer.onFocusChangeListener = listener
        onDispose { if (composer.onFocusChangeListener === listener) composer.onFocusChangeListener = previous }
    }
    val density = androidx.compose.ui.platform.LocalDensity.current
    val body = MaterialTheme.typography.bodyLarge
    val textSize = with(density) { body.fontSize.toPx() }
    val lineHeight = with(density) { body.lineHeight.toPx().toInt() }
    val textColor = MaterialTheme.colorScheme.onSurface.toArgb()
    val hintColor = MaterialTheme.colorScheme.onSurfaceVariant.toArgb()
    val active = activeRuns(state)
    val stop = active.isNotEmpty() && !state.hasInput
    val stopping = active.any { it.optString("id") == state.stoppingRunId }
    Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp).padding(top = if (tight) 2.dp else 4.dp, bottom = if (tight) 2.dp else 8.dp)) {
        if (!tight && active.isNotEmpty()) Row(Modifier.fillMaxWidth().height(28.dp).testTag("streaming-status"), verticalAlignment = Alignment.CenterVertically) {
            CircularProgressIndicator(Modifier.size(12.dp), color = MaterialTheme.colorScheme.primary, strokeWidth = 1.5.dp)
            Spacer(Modifier.width(8.dp))
            Text(if (stopping) mobileText(R.string.label_stopping) else if (active.all { it.optString("status") == "queued" }) mobileText(R.string.label_queued) else mobileText(R.string.label_replying), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (!tight && active.isEmpty()) {
            val latest = state.runs.maxByOrNull { it.optString("startedAt") }
            if (latest?.optString("status") == "failed") Text(
                mobileText(R.string.label_the_reply_did_not_complete_try_another_model_and_resend),
                Modifier.padding(horizontal = 8.dp, vertical = 6.dp).testTag("reply-failed"), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
        }
        Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surfaceContainer, border = BorderStroke(1.dp, if (focused.value) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline), shadowElevation = 1.dp) {
            Column(Modifier.fillMaxWidth().padding(if (tight) 0.dp else 6.dp)) {
                if (!tight) AttachmentStrip(state, onAction)
                AndroidView(
                    factory = { (composer.parent as? ViewGroup)?.removeView(composer); composer },
                    update = { input ->
                        input.setTextColor(textColor); input.setHintTextColor(hintColor)
                        input.includeFontPadding = false
                        input.typeface = android.graphics.Typeface.create("sans-serif", android.graphics.Typeface.NORMAL)
                        if (input.textSize != textSize) input.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, textSize)
                        androidx.core.widget.TextViewCompat.setLineHeight(input, lineHeight)
                        input.setBackgroundColor(android.graphics.Color.TRANSPARENT)
                        input.hint = mobileText(R.string.label_what_would_you_like_lexora_to_do)
                        input.isEnabled = state.inputEnabled; input.minLines = 1; input.maxLines = 6
                        input.gravity = Gravity.TOP or Gravity.START
                    },
                    modifier = Modifier.fillMaxWidth().heightIn(min = 44.dp, max = inputMaxHeight).padding(horizontal = 10.dp).testTag("input"),
                )
                ComposerToolbar(state, onAction, attachments, stop, stopping, active, runs)
            }
        }
        if (!tight && state.inputFeedback.isNotBlank() && state.inputFeedback != mobileText(R.string.mobile_saved_on_phone)) Text(state.inputFeedback, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp))
    }
}

@Composable
private fun Notice(text: String, dismiss: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(start = 20.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(text, Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
            IconButton(onClick = dismiss, modifier = Modifier.size(48.dp)) { Icon(Icons.Outlined.Close, mobileText(R.string.label_dismiss_notice), Modifier.size(18.dp)) }
        }
    }
}

@Composable
private fun EmptyPane(title: String, body: String, actionLabel: String? = null, onAction: () -> Unit = {}) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val showCompanion = maxHeight >= 320.dp
        Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 16.dp), verticalArrangement = Arrangement.Center) {
            if (showCompanion) { PaintedCompanion(); Spacer(Modifier.height(18.dp)) }
            Text(title, style = MaterialTheme.typography.headlineMedium)
            Spacer(Modifier.height(12.dp))
            Text(body, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (actionLabel != null) {
                Spacer(Modifier.height(16.dp))
                TextButton(onClick = onAction, contentPadding = PaddingValues(horizontal = 0.dp), modifier = Modifier.heightIn(min = 48.dp)) {
                    Text(actionLabel); Spacer(Modifier.width(8.dp)); Icon(Icons.AutoMirrored.Outlined.ArrowForward, null, Modifier.size(18.dp))
                }
            }
        }
    }
}

@Composable
private fun RowDivider() = HorizontalDivider(Modifier.padding(horizontal = 20.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.45f))

private data class SheetEntry(val title: String, val icon: ImageVector, val action: MobileAction? = null, val next: MobileSheet? = null)

private fun sheetEntries(sheet: MobileSheet, state: MobileUiState): List<SheetEntry> = when (sheet) {
    MobileSheet.Attachments -> listOf(SheetEntry(mobileText(R.string.label_choose_file), Icons.Outlined.AttachFile, MobileAction.AttachFile), SheetEntry(mobileText(R.string.label_take_photo), Icons.Outlined.PhotoCamera, MobileAction.TakePhoto), SheetEntry(mobileText(R.string.label_task_files), Icons.Outlined.FolderOpen, MobileAction.Files))
    MobileSheet.Workbench -> buildList {
        add(SheetEntry(mobileText(R.string.label_all_tasks), Icons.Outlined.Search, MobileAction.ShowTasks))
        add(SheetEntry(mobileText(R.string.label_spaces), Icons.Outlined.FolderOpen, MobileAction.ShowSpaces))
        add(SheetEntry(mobileText(R.string.label_send_history), Icons.Outlined.Send, MobileAction.Outbox))
        add(SheetEntry(mobileText(R.string.label_local_drafts), Icons.Outlined.EditNote, MobileAction.Recovery))
        add(SheetEntry(mobileText(R.string.label_refresh), Icons.Outlined.Refresh, MobileAction.Refresh))
        if (!state.connected && state.devices.isNotEmpty()) add(SheetEntry(mobileText(R.string.label_reconnect), Icons.Outlined.Wifi, MobileAction.Reconnect))
    }
    MobileSheet.Task -> buildList {
        add(SheetEntry(mobileText(R.string.label_task_files), Icons.Outlined.FolderOpen, MobileAction.Files))
        if (state.selectedTask != null) {
            if (state.questionsSupported && state.questions.isNotEmpty()) add(SheetEntry(mobileText(R.string.label_questions_answers), Icons.Outlined.ChatBubbleOutline, next = MobileSheet.Questions))
            add(SheetEntry(mobileText(R.string.label_approvals), Icons.Outlined.FactCheck, MobileAction.Approvals))
            add(SheetEntry(mobileText(R.string.label_runs_stop), Icons.Outlined.Tune, MobileAction.TaskControls))
            add(SheetEntry(mobileText(R.string.label_branches), Icons.Outlined.AccountTree, MobileAction.TaskBranches))
            add(SheetEntry(mobileText(R.string.label_queued_messages), Icons.AutoMirrored.Outlined.ListAlt, next = MobileSheet.Queue))
        }
        add(SheetEntry(mobileText(R.string.more_options), Icons.Outlined.MoreHoriz, next = MobileSheet.TaskMore))
    }
    MobileSheet.Queue -> listOf(SheetEntry(mobileText(R.string.label_view_queue), Icons.AutoMirrored.Outlined.ListAlt, MobileAction.TaskQueue), SheetEntry(mobileText(R.string.label_queue_current_input), Icons.Outlined.PlaylistAdd, MobileAction.QueueInput))
    MobileSheet.TaskMore -> buildList {
        if (state.selectedTask != null) {
            add(SheetEntry(mobileText(R.string.label_earlier_messages), Icons.Outlined.History, MobileAction.MoreHistory))
            add(SheetEntry(mobileText(R.string.label_open_on_desktop), Icons.Outlined.OpenInNew, MobileAction.OpenOnDesktop))
            add(SheetEntry(mobileText(R.string.label_read_status), Icons.Outlined.DoneAll, MobileAction.ReadState))
        }
        add(SheetEntry(mobileText(R.string.label_send_history), Icons.Outlined.Send, MobileAction.Outbox))
        add(SheetEntry(mobileText(R.string.label_local_drafts), Icons.Outlined.EditNote, MobileAction.Recovery))
        add(SheetEntry(mobileText(R.string.label_refresh), Icons.Outlined.Refresh, MobileAction.Refresh))
    }
    else -> emptyList()
}

@Composable
internal fun ActionRow(title: String, icon: ImageVector, subtitle: String? = null, enabled: Boolean = true, checked: Boolean = false, tag: String? = null, modifier: Modifier = Modifier, action: () -> Unit) {
    Row(
        modifier.fillMaxWidth().heightIn(min = 56.dp).clip(MaterialTheme.shapes.small).then(if (tag != null) Modifier.testTag(tag) else Modifier)
            .clickable(enabled = enabled, role = Role.Button, onClick = action).padding(horizontal = 12.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
        Icon(icon, null, Modifier.size(22.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(16.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = color, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (!subtitle.isNullOrBlank()) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (checked) Icon(Icons.Outlined.Check, mobileText(R.string.label_selected), Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
    }
}

internal fun taskTitle(task: JSONObject) = (task.opt("title") as? String)?.takeIf { it.isNotBlank() } ?: mobileText(R.string.label_untitled_task)
private fun taskSpaceId(task: JSONObject): String? = (task.opt("spaceId") as? String)?.takeIf { it.isNotEmpty() }
private fun scopedTasks(tasks: List<JSONObject>, spaceId: String?): List<JSONObject> = if (spaceId == null) tasks else tasks.filter { taskSpaceId(it).orEmpty() == spaceId }
private fun taskSpaceLabel(task: JSONObject, spaces: List<JSONObject>): String {
    val id = taskSpaceId(task) ?: return mobileText(R.string.label_no_space)
    return spaces.firstOrNull { it.optString("id") == id }?.optString("name")?.takeIf { it.isNotBlank() } ?: mobileText(R.string.label_space_task)
}
private fun taskTime(task: JSONObject): String? {
    val time = when (val value = task.opt("updatedAt")) {
        is Number -> value.toLong()
        is String -> runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
        else -> null
    } ?: return null
    val now = System.currentTimeMillis()
    val minutes = (now - time) / 60000
    if (kotlin.math.abs(minutes) < 1) return mobileText(R.string.label_just_now)
    val (amount, unit) = when {
        kotlin.math.abs(minutes) < 60 -> minutes to RelativeDateTimeFormatter.RelativeUnit.MINUTES
        kotlin.math.abs(minutes) < 1440 -> minutes / 60 to RelativeDateTimeFormatter.RelativeUnit.HOURS
        else -> minutes / 1440 to RelativeDateTimeFormatter.RelativeUnit.DAYS
    }
    return RelativeDateTimeFormatter.getInstance(MobileStrings.locale).format(kotlin.math.abs(amount).toDouble(),
        if (amount > 0) RelativeDateTimeFormatter.Direction.LAST else RelativeDateTimeFormatter.Direction.NEXT, unit)
}

private fun modelLabel(state: MobileUiState) = state.modelLabel.takeUnless { it.isBlank() || it == mobileText(R.string.label_choose_model) } ?: mobileText(R.string.label_choose_model)
internal fun activeRuns(state: MobileUiState) = state.runs.filter { it.optString("executionKind") != "maintenance" && it.optString("status") in setOf("queued", "running") }.sortedByDescending { it.optString("startedAt") }
private fun questionSummary(request: JSONObject) = request.optJSONArray("questions")?.optJSONObject(0)?.optString("question")?.takeIf { it.isNotBlank() } ?: mobileText(R.string.label_view_and_answer)
private fun runStartedLabel(run: JSONObject): String? {
    val value = run.opt("startedAt")
    val time = when (value) {
        is Number -> value.toLong()
        is String -> runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
        else -> null
    } ?: return null
    return mobileText(R.string.mobile_started, java.text.DateFormat.getTimeInstance(java.text.DateFormat.SHORT, MobileStrings.locale).format(java.util.Date(time)))
}

private fun branchCreatedLabel(branch: JSONObject): String? {
    val value = branch.opt("createdAt")
    val time = when (value) {
        is Number -> value.toLong()
        is String -> runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
        else -> null
    } ?: return null
    return java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.SHORT, MobileStrings.locale).format(java.util.Date(time))
}

internal fun branchLabel(state: MobileUiState, id: String): String {
    val index = state.branches.indexOfFirst { it.optString("id") == id }
    if (index < 0) return mobileText(R.string.label_branches)
    return if (state.branches[index].isNull("parentBranchId")) mobileText(R.string.label_original_branch) else mobileText(R.string.mobile_branch, index + 1)
}

private fun questionStateLabel(question: JSONObject) = when (question.optString("status")) {
    "pending" -> mobileText(R.string.label_needs_an_answer)
    "answered" -> when (question.optJSONObject("delivery")?.optString("state")) { "failed" -> mobileText(R.string.mobile_answer_not_delivered); "pending" -> mobileText(R.string.mobile_answer_awaiting_delivery); else -> mobileText(R.string.label_answered) }
    "cancelled" -> when (question.optJSONObject("delivery")?.optString("state")) { "failed" -> mobileText(R.string.mobile_skip_result_not_delivered); "pending" -> mobileText(R.string.mobile_skip_result_awaiting_delivery); else -> mobileText(R.string.label_skipped) }
    "interrupted" -> mobileText(R.string.label_question_interrupted)
    else -> mobileText(R.string.label_question_history)
}
private fun questionActionLabel(question: JSONObject) = when {
    question.optString("status") == "pending" -> mobileText(R.string.question_answers)
    question.optJSONObject("delivery")?.optString("state") == "failed" -> mobileText(R.string.label_retry)
    else -> mobileText(R.string.label_view)
}
