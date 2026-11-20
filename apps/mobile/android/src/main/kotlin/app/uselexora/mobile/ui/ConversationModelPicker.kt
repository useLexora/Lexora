package app.uselexora.mobile.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText
import kotlinx.coroutines.launch
import org.json.JSONObject

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ConversationModelPicker(state: MobileUiState, onAction: (MobileAction, JSONObject?) -> Unit) {
    val target = pickerTarget(state)
    var query by remember(target) { mutableStateOf("") }
    var pending by remember(target) { mutableStateOf<JSONObject?>(null) }
    val selection = pending ?: state.modelSelection
    val model = MobileModelControls.model(selection, state.models)
    val parameters = model?.let {
        MobileModelControls.resolve(MobileModelControls.parameters(it, selection?.opt("reasoning") as? String, selection?.opt("serviceTier") as? String), state.models)
    }
    val initialProvider = remember(target) { state.modelSelection?.optString("providerId") }
    val initialModel = remember(target) { state.modelSelection?.optString("modelId") }
    var browsingProvider by remember(target) { mutableStateOf(initialProvider) }
    var searchProvider by remember(target) { mutableStateOf<String?>(null) }
    val providerNames = state.modelProviders.associate { it.getString("id") to it.getString("displayName") }
    val groups = state.models.filter {
        it.optString("displayName").contains(query, true) || it.optString("modelId").contains(query, true)
            || providerNames[it.optString("providerId")]?.contains(query, true) == true
    }.groupBy { it.getString("providerId") }.entries.sortedBy { if (it.key == initialProvider) 0 else 1 }
    val providerFilter = (if (query.isBlank()) browsingProvider else searchProvider)?.takeIf { id -> groups.any { it.key == id } }
        ?: groups.singleOrNull()?.key?.takeIf { query.isBlank() }
    val visibleGroups = groups.filter { providerFilter == null || it.key == providerFilter }
    val selectionVisible = visibleGroups.any { group -> group.value.any { it === model } }
    val list = rememberLazyListState()
    val providerTabs = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    val editable = state.configEnabled && state.inputEnabled
    LaunchedEffect(query, providerFilter, groups.map { it.key }) {
        list.scrollToItem(0)
        val offset = if (groups.size > 1 || query.isNotBlank()) 1 else 0
        val index = if (providerFilter == null) 0 else groups.indexOfFirst { it.key == providerFilter } + offset
        providerTabs.animateScrollToItem((index - 1).coerceAtLeast(0))
    }
    ModalBottomSheet(onDismissRequest = { state.modelPickerOpen = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxWidth().height((LocalConfiguration.current.screenHeightDp.dp * .8f).coerceAtMost(480.dp)).padding(horizontal = 16.dp).testTag("model-picker")) {
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(mobileText(R.string.label_choose_model), Modifier.weight(1f).padding(start = 4.dp), style = MaterialTheme.typography.titleMedium)
                IconButton(onClick = { state.modelPickerOpen = false }, modifier = Modifier.size(48.dp).testTag("close-model-picker")) {
                    Icon(desktopSymbol(DesktopSymbol.Close), mobileText(R.string.label_close_model_picker), Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            OutlinedTextField(query, { query = it; searchProvider = null }, modifier = Modifier.fillMaxWidth().padding(top = 4.dp, bottom = 8.dp).testTag("model-search"),
                singleLine = true, textStyle = MaterialTheme.typography.bodyMedium, shape = RoundedCornerShape(12.dp),
                placeholder = { Text(mobileText(R.string.label_search_models), style = MaterialTheme.typography.bodyMedium) },
                leadingIcon = { Icon(desktopSymbol(DesktopSymbol.Search), null, Modifier.size(18.dp)) }, trailingIcon = {
                    if (query.isNotEmpty()) IconButton(onClick = { query = "" }, modifier = Modifier.testTag("clear-model-search")) {
                        Icon(desktopSymbol(DesktopSymbol.Close), mobileText(R.string.mobile_clear_model_search), Modifier.size(18.dp))
                    }
                })
            if (state.modelsLoading) LinearProgressIndicator(Modifier.fillMaxWidth())
            if (state.modelsError.isNotEmpty()) TextButton(onClick = { onAction(MobileAction.ChooseModel, null) }) {
                Text(state.modelsError, style = MaterialTheme.typography.bodySmall)
            }
            if (groups.isNotEmpty()) LazyRow(Modifier.fillMaxWidth().padding(bottom = 8.dp).testTag("model-providers"), state = providerTabs, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                if (groups.size > 1 || query.isNotBlank()) item(key = "all") {
                    ModelProviderTab(mobileText(R.string.label_all), groups.sumOf { it.value.size }, providerFilter == null, null) {
                        if (query.isBlank()) browsingProvider = null else searchProvider = null
                        focus.clearFocus(); keyboard?.hide()
                    }
                }
                items(groups, key = { "provider:${it.key}" }) { group ->
                    ModelProviderTab(providerNames[group.key] ?: mobileText(R.string.mobile_other_models), group.value.size, providerFilter == group.key, group.key) {
                        if (query.isBlank()) browsingProvider = group.key else searchProvider = group.key
                        focus.clearFocus(); keyboard?.hide()
                    }
                }
            }
            LazyColumn(Modifier.weight(1f).testTag("model-list"), state = list, contentPadding = PaddingValues(bottom = 8.dp)) {
                if (!state.modelsLoading && state.modelsError.isEmpty() && groups.isEmpty()) item {
                    Text(mobileText(R.string.label_no_matching_models), Modifier.fillMaxWidth().padding(24.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                var rowIndex = 0
                for ((providerId, candidates) in visibleGroups) {
                    val headerSize = if (providerFilter == null) 1 else 0
                    val modelStart = rowIndex + headerSize
                    if (headerSize > 0) item(key = "provider:$providerId") {
                        Text(providerNames[providerId] ?: mobileText(R.string.mobile_other_models), Modifier.padding(horizontal = 12.dp, vertical = 8.dp).testTag("model-provider:$providerId"),
                            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    val ordered = candidates.sortedBy { if (it.optString("providerId") == initialProvider && it.optString("modelId") == initialModel) 0 else 1 }
                    itemsIndexed(ordered, key = { _, it -> "model:${it.getString("providerId")}:${it.getString("modelId")}" }) { index, candidate ->
                        val current = candidate === model
                        Surface(shape = RoundedCornerShape(12.dp), color = if (current) MaterialTheme.colorScheme.surfaceContainerHigh else MaterialTheme.colorScheme.background,
                            modifier = Modifier.fillMaxWidth().padding(bottom = 2.dp)) {
                            Column {
                                Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("model-option:${candidate.getString("providerId")}:${candidate.getString("modelId")}")
                                    .semantics { selected = current }.clickable(enabled = editable, role = Role.RadioButton) {
                                        if (pickerTarget(state) == target) {
                                            pending = MobileModelControls.resolve(MobileModelControls.parameters(candidate, parameters?.opt("reasoning") as? String, parameters?.opt("serviceTier") as? String), state.models)
                                            if (query.isNotBlank()) browsingProvider = candidate.getString("providerId")
                                            focus.clearFocus(); keyboard?.hide()
                                            scope.launch { list.animateScrollToItem(modelStart + index) }
                                        }
                                    }.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Column(Modifier.weight(1f)) {
                                        Text(candidate.getString("displayName"), style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                        if (candidates.count { it.optString("displayName") == candidate.optString("displayName") } > 1) {
                                            Text(candidate.getString("modelId"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        }
                                    }
                                    if (current) Icon(desktopSymbol(DesktopSymbol.Check), mobileText(R.string.label_selected), Modifier.padding(start = 8.dp).size(18.dp), tint = MaterialTheme.colorScheme.primary)
                                }
                                if (current && parameters != null) key(target) {
                                    ModelParameters(candidate, parameters, state.models, editable) { pending = it }
                                }
                            }
                        }
                    }
                    rowIndex += candidates.size + headerSize
                }
            }
            if (state.modelConfirmError.isNotEmpty()) {
                Text(state.modelConfirmError, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
            Button(enabled = editable && state.modelConfirmEnabled && model != null && selectionVisible, onClick = {
                val latest = MobileModelControls.model(selection, state.models)
                if (pickerTarget(state) == target && state.configEnabled && state.inputEnabled && state.modelConfirmEnabled && latest != null && selectionVisible) {
                    onAction(MobileAction.ApplyModel, MobileModelControls.parameters(latest, parameters?.opt("reasoning") as? String, parameters?.opt("serviceTier") as? String))
                }
            }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp, bottom = 8.dp).heightIn(min = 48.dp).testTag("apply-model"), shape = RoundedCornerShape(12.dp)) {
                Text(mobileText(R.string.label_confirm))
            }
        }
    }
}

@Composable
private fun ModelProviderTab(label: String, count: Int, active: Boolean, id: String?, select: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    TextButton(onClick = select, shape = RoundedCornerShape(10.dp), contentPadding = PaddingValues(horizontal = 12.dp),
        colors = ButtonDefaults.textButtonColors(contentColor = if (active) colors.primary else colors.onSurfaceVariant,
            containerColor = if (active) colors.primary.copy(alpha = .1f) else androidx.compose.ui.graphics.Color.Transparent),
        modifier = Modifier.heightIn(min = 48.dp).widthIn(max = 168.dp).testTag(if (id == null) "model-providers-all" else "model-provider-tab:$id").semantics { selected = active; role = Role.Tab }) {
        Text(label, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Spacer(Modifier.width(6.dp))
        Text(count.toString(), style = MaterialTheme.typography.labelSmall)
    }
}

@Composable
private fun ModelParameters(model: JSONObject, parameters: JSONObject, models: List<JSONObject>, enabled: Boolean, change: (JSONObject) -> Unit) {
    val reasons = model.optJSONArray("reasoningOptions")
    val fast = MobileModelControls.supportsFast(model, models)
    if ((reasons == null || reasons.length() == 0) && !fast) return
    Column(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 12.dp).testTag("model-parameters"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        if (reasons != null && reasons.length() > 0) {
            val options = (0 until reasons.length()).map { reasons.getString(it) }
            val current = parameters.getString("reasoning")
            var expanded by remember(options, enabled) { mutableStateOf(false) }
            Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).testTag("reasoning-selector")
                .clickable(enabled = enabled, role = Role.DropdownList) { expanded = true },
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(mobileText(R.string.label_reasoning_effort), Modifier.weight(1f), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(current, style = MaterialTheme.typography.bodyMedium)
                Box {
                    Icon(desktopSymbol(DesktopSymbol.ChevronDown), null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                        for (value in options) {
                            val checked = current == value
                            DropdownMenuItem(text = { Text(value) }, modifier = Modifier.testTag("reasoning:$value").semantics {
                                selected = checked; role = Role.RadioButton
                            }, trailingIcon = {
                                if (checked) Icon(desktopSymbol(DesktopSymbol.Check), null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.primary)
                            }, onClick = {
                                expanded = false
                                change(MobileModelControls.parameters(model, value, parameters.opt("serviceTier") as? String))
                            })
                        }
                    }
                }
            }
        }
        if (fast) Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text(mobileText(R.string.fast_mode), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
            Switch(checked = parameters.opt("serviceTier") == "priority", enabled = enabled,
                onCheckedChange = { change(MobileModelControls.parameters(model, parameters.opt("reasoning") as? String, if (it) "priority" else null)) },
                modifier = Modifier.testTag("fast-mode").semantics { contentDescription = mobileText(R.string.label_fast_priority_processing) })
        }
    }
}
