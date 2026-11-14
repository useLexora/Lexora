package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.json.JSONObject

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TaskFilesPanel(files: MobileTaskFiles, onAction: (MobileAction, JSONObject?) -> Unit, close: () -> Unit) {
    ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        LazyColumn(Modifier.fillMaxWidth().testTag("task-files"), contentPadding = PaddingValues(16.dp, 0.dp, 16.dp, 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(mobileText(R.string.label_task_files), Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    IconButton(onClick = { close(); onAction(MobileAction.ManageFiles, null) }) { Icon(Icons.Outlined.MoreHoriz, mobileText(R.string.more_options)) }
                }
                Text(mobileText(R.string.task_files_hint), Modifier.padding(top = 4.dp, bottom = 12.dp), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            items(files.items, key = { it.getString("resourceId") }) { resource ->
                Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainer) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Row(Modifier.weight(1f).clickable { onAction(MobileAction.OpenResource, resource) }.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                            val mime = resource.optString("mimeType")
                            Icon(when { mime.startsWith("image/") -> Icons.Outlined.Image; mime == "application/pdf" -> Icons.Outlined.PictureAsPdf; else -> Icons.Outlined.Description }, null)
                            Column(Modifier.padding(start = 12.dp)) {
                                Text(resource.getString("name"), maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleSmall)
                                val size = resource.optLong("sizeBytes")
                                Text(if (size > 0) android.text.format.Formatter.formatShortFileSize(androidx.compose.ui.platform.LocalContext.current, size) else mobileText(R.string.file_label), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        IconButton(onClick = { onAction(MobileAction.ResourceActions, resource) }) { Icon(Icons.Outlined.MoreHoriz, mobileText(R.string.file_more_actions, resource.getString("name"))) }
                    }
                }
            }
            if (files.loading) item { LinearProgressIndicator(Modifier.fillMaxWidth().padding(vertical = 16.dp)) }
            else if (files.error != null) item {
                Text(files.error, color = MaterialTheme.colorScheme.error)
                TextButton(onClick = { onAction(MobileAction.MoreFiles, null) }) { Text(mobileText(R.string.reload_files)) }
            }
            else if (files.items.isEmpty()) item { Text(mobileText(R.string.no_task_files), Modifier.padding(vertical = 32.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            else if (files.nextCursor != null) item { TextButton(onClick = { onAction(MobileAction.MoreFiles, null) }, modifier = Modifier.fillMaxWidth()) { Text(mobileText(R.string.load_more_files)) } }
        }
    }
}
