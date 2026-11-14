package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileQuantity
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import org.json.JSONObject

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun IncomingMaterialPanel(material: IncomingMaterial, state: MobileUiState, choose: (String, JSONObject?) -> Unit, dismiss: () -> Unit) {
    var pickTask by remember(material.id) { mutableStateOf(false) }
    ModalBottomSheet(onDismissRequest = { if (!state.importingMaterial) dismiss() }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        LazyColumn(Modifier.fillMaxWidth().testTag("incoming-material"), contentPadding = PaddingValues(16.dp, 0.dp, 16.dp, 24.dp)) {
            item {
                Text(mobileText(R.string.incoming_title), style = MaterialTheme.typography.titleLarge)
                Text(listOfNotNull(if (material.text.isNotBlank()) mobileText(R.string.incoming_text) else null, if (material.uris.isNotEmpty()) mobileQuantity(R.plurals.incoming_files, material.uris.size) else null).joinToString(" · "), Modifier.padding(vertical = 12.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(mobileText(R.string.incoming_hint), style = MaterialTheme.typography.bodyMedium)
                if (material.text.isNotBlank()) Text(material.text.take(240), Modifier.padding(vertical = 12.dp), maxLines = 4, style = MaterialTheme.typography.bodySmall)
            }
            if (state.importingMaterial) item { LinearProgressIndicator(Modifier.fillMaxWidth().padding(vertical = 24.dp)); Text(mobileText(R.string.incoming_saving)) }
            else if (material.partition != null) item {
                Text(state.materialError.ifBlank { mobileText(R.string.incoming_resume) }, color = MaterialTheme.colorScheme.onSurfaceVariant)
                ActionRow(mobileText(R.string.incoming_retry), Icons.Outlined.Refresh) { choose("retry", null) }
            }
            else if (state.devices.none { it.selected } && !state.connected) item {
                Text(mobileText(R.string.incoming_service_required), Modifier.padding(vertical = 12.dp))
                ActionRow(mobileText(R.string.incoming_connect), Icons.Outlined.Devices) { choose("connect", null) }
            }
            else if (pickTask) {
                item { TextButton(onClick = { pickTask = false }) { Text(mobileText(R.string.label_back)) } }
                items(state.tasks, key = { it.getString("id") }) { task -> ActionRow(taskTitle(task), Icons.Outlined.ChatBubbleOutline) { choose("task", task) } }
                if (state.tasks.isEmpty()) item { Text(mobileText(R.string.incoming_no_tasks), Modifier.padding(16.dp)) }
            }
            else {
                item { Text(mobileText(R.string.incoming_service, state.deviceLabel), Modifier.padding(top = 16.dp), style = MaterialTheme.typography.labelMedium) }
                item { ActionRow(mobileText(R.string.label_new_task), Icons.Outlined.Add, mobileText(R.string.incoming_new_task_hint)) { choose("new", null) } }
                if (state.screen == MobileScreen.Conversation && state.inputEnabled) item { ActionRow(mobileText(R.string.incoming_current), Icons.Outlined.EditNote, state.selectedTask?.let(::taskTitle) ?: mobileText(R.string.incoming_new_draft)) { choose("current", null) } }
                item { ActionRow(mobileText(R.string.incoming_choose_task), Icons.Outlined.ChatBubbleOutline) { pickTask = true } }
                if (state.materialError.isNotBlank()) item { Text(state.materialError, color = MaterialTheme.colorScheme.error) }
            }
        }
    }
}
