package app.uselexora.mobile.ui

import android.text.format.Formatter
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.MobileStrings
import app.uselexora.mobile.i18n.mobileText
import java.text.NumberFormat
import app.uselexora.mobile.network.DownloadRecord
import app.uselexora.mobile.network.DownloadState
import app.uselexora.mobile.network.DownloadState.*
import app.uselexora.mobile.network.MobileFiles
import app.uselexora.mobile.preview.PreviewPolicy
import org.json.JSONObject

enum class DownloadUiAction { Pause, Resume, Cancel, Open }
internal class ResourceMenuUi(val resource: JSONObject, val onSelect: (Int) -> Unit)

private val DownloadState.label get() = when (this) {
    QUEUED -> R.string.label_queued
    RUNNING -> R.string.download_running
    VERIFYING -> R.string.download_verifying
    PAUSED -> R.string.mobile_paused
    INTERRUPTED -> R.string.download_interrupted
    FAILED -> R.string.download_failed
    COMPLETED -> R.string.mobile_completed
    CANCELLED -> R.string.mobile_cancelled
}

private val DownloadState.section get() = when (this) {
    QUEUED, RUNNING, VERIFYING, PAUSED, INTERRUPTED -> R.string.label_in_progress
    COMPLETED -> R.string.mobile_completed
    FAILED, CANCELLED -> R.string.downloads_stopped
}

@Composable
internal fun DownloadsSettingsRow(open: () -> Unit) {
    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerHigh) {
        SettingsRow(mobileText(R.string.downloads_title), Icons.Outlined.Download, tag = "settings-downloads", divider = false, action = open)
    }
}

@Composable
internal fun DownloadsPage(records: List<DownloadRecord>?, onAction: ((DownloadUiAction, String) -> Unit)?, close: () -> Unit) {
    var detailId by rememberSaveable { mutableStateOf<String?>(null) }
    val detail = detailId?.let { id -> records?.find { it.id == id } }
    val listState = rememberLazyListState()
    val back: () -> Unit = { if (detail != null) detailId = null else close() }
    BackHandler(onBack = back)
    Surface(Modifier.fillMaxSize().testTag("downloads-page"), color = MaterialTheme.colorScheme.background) {
        Column {
            SettingsHeader(mobileText(if (detail == null) R.string.downloads_title else R.string.download_detail), mobileText(R.string.label_back), back)
            when {
                detail != null -> DownloadDetail(detail, onAction)
                records.isNullOrEmpty() -> Column(Modifier.fillMaxSize().padding(32.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
                    if (records == null) CircularProgressIndicator(Modifier.size(28.dp))
                    else Icon(Icons.Outlined.FileDownload, null, Modifier.size(36.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(mobileText(if (records == null) R.string.downloads_loading else R.string.downloads_empty), Modifier.padding(top = 16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                else -> {
                    val sections = remember(records) { records.groupBy { it.state.section } }
                    LazyColumn(state = listState, contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp)) {
                        for (section in listOf(R.string.label_in_progress, R.string.mobile_completed, R.string.downloads_stopped)) {
                            val rows = sections[section] ?: continue
                            item(key = section) {
                                Text(mobileText(R.string.download_group_count, mobileText(section), rows.size), Modifier.padding(start = 4.dp, top = 20.dp, bottom = 8.dp).semantics { heading() },
                                    style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
                            }
                            items(rows, key = { it.id }) { record ->
                                DownloadRecordRow(record) { detailId = record.id }
                                HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun FileGlyph(mime: String) {
    Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Box(Modifier.size(40.dp), contentAlignment = Alignment.Center) {
            Icon(when {
                mime.startsWith("image/") -> Icons.Outlined.Image
                mime == "application/pdf" -> Icons.Outlined.PictureAsPdf
                else -> Icons.Outlined.Description
            }, null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(22.dp))
        }
    }
}

@Composable
private fun DownloadRecordRow(record: DownloadRecord, click: () -> Unit) {
    Surface(onClick = click, modifier = Modifier.fillMaxWidth().testTag("download-record-${record.id}"), color = MaterialTheme.colorScheme.background) {
        Row(Modifier.padding(horizontal = 4.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            FileGlyph(record.mimeType)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(record.name, style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                if (record.state == COMPLETED) {
                    Text(Formatter.formatShortFileSize(LocalContext.current, record.totalBytes ?: record.bytes), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else DownloadProgress(record)
            }
            if (record.state == COMPLETED) Icon(Icons.Outlined.CheckCircle, mobileText(R.string.mobile_completed), Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
        }
    }
}

@Composable
private fun DownloadProgress(record: DownloadRecord) {
    val total = record.totalBytes
    val context = LocalContext.current
    fun format(bytes: Long) = Formatter.formatShortFileSize(context, bytes)
    val fraction = total?.takeIf { it > 0 }?.let { (record.bytes.toDouble() / it).coerceIn(0.0, 1.0) }
    val active = record.state.section == R.string.label_in_progress
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(mobileText(record.state.label), Modifier.weight(1f), style = MaterialTheme.typography.labelMedium,
            color = if (record.state == FAILED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant)
        if (active && fraction != null) Text(remember(MobileStrings.locale, fraction) {
            NumberFormat.getPercentInstance(MobileStrings.locale).apply { roundingMode = java.math.RoundingMode.DOWN }.format(fraction)
        }, style = MaterialTheme.typography.labelMedium)
    }
    if (active) {
        if (record.state == VERIFYING || (fraction == null && record.state == RUNNING)) LinearProgressIndicator(Modifier.fillMaxWidth())
        else if (fraction != null) LinearProgressIndicator(progress = { fraction.toFloat() }, modifier = Modifier.fillMaxWidth())
    }
    Text(when {
        record.state == COMPLETED -> format(total ?: record.bytes)
        total != null -> mobileText(R.string.download_progress, format(record.bytes), format(total))
        else -> mobileText(R.string.download_progress_unknown, format(record.bytes))
    }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
private fun DownloadDetail(record: DownloadRecord, onAction: ((DownloadUiAction, String) -> Unit)?) {
    Column(Modifier.verticalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
        Text(record.name, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
        Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerHigh) {
            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                DownloadProgress(record)
                if (record.mimeType.isNotBlank()) DetailField(R.string.download_file_type, record.mimeType)
                DownloadDestinationLabel(record)
                record.error?.let { code -> DetailField(R.string.download_error, mobileText(downloadErrorLabel(code))) }
            }
        }
        DownloadControls(record, onAction)
    }
}

@Composable
private fun DownloadDestinationLabel(record: DownloadRecord) = DetailField(R.string.download_location,
    mobileText(if (record.customFolder) R.string.download_selected_location else R.string.download_default_folder))

private fun downloadErrorLabel(code: String) = when (code) {
    "VERSION_CHANGED", "CONTENT_HASH_MISMATCH" -> R.string.mobile_content_changed_or_verification_failed_load_it_again
    "RESOURCE_UNAVAILABLE", "OBJECT_DELETED" -> R.string.error_resource_unavailable
    "SERVICE_UNREACHABLE", "NOT_CONNECTED", "CONNECTION_CLOSED", "TIMEOUT" -> R.string.error_service_unreachable
    "LOCAL_STORAGE_FAILED", "DOWNLOAD_DIRECTORY_REQUIRED" -> R.string.download_destination_failed
    "NOT_AUTHORIZED" -> R.string.error_not_authorized
    "DOWNLOAD_INTERRUPTED" -> R.string.download_interrupted_help
    else -> R.string.download_failed
}

@Composable
private fun DetailField(label: Int, value: String) {
    Column(Modifier.padding(top = 4.dp)) {
        Text(mobileText(label), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text(value, style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
private fun DownloadControls(record: DownloadRecord, onAction: ((DownloadUiAction, String) -> Unit)?) {
    if (onAction == null) return
    val canCancel = record.state !in listOf(COMPLETED, CANCELLED)
    var confirming by remember(record.id, canCancel) { mutableStateOf(false) }
    val perform: (DownloadUiAction) -> Unit = { onAction(it, record.id) }
    if (record.state == COMPLETED && record.uri != null) {
        val install = ApkInstall.matches(record.name, record.mimeType)
        ActionRow(mobileText(if (install) R.string.install_apk else R.string.open_other_app), if (install) Icons.Outlined.InstallMobile else Icons.Outlined.OpenInNew, tag = "download-open") { perform(DownloadUiAction.Open) }
    }
    if (canCancel) Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        val canPause = record.state in listOf(QUEUED, RUNNING, VERIFYING)
        val primary = if (canPause) DownloadUiAction.Pause else DownloadUiAction.Resume
        val label = if (canPause) R.string.download_pause else if (record.state == FAILED) R.string.label_retry else R.string.download_resume
        OutlinedButton(onClick = { perform(primary) }, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag(if (canPause) "download-pause" else "download-resume"), shape = MaterialTheme.shapes.medium) {
            Icon(if (canPause) Icons.Outlined.Pause else Icons.Outlined.PlayArrow, null, Modifier.size(18.dp))
            Spacer(Modifier.width(4.dp)); Text(mobileText(label))
        }
        OutlinedButton(onClick = { confirming = true }, modifier = Modifier.weight(1f).heightIn(min = 48.dp).testTag("download-cancel"), shape = MaterialTheme.shapes.medium) { Text(mobileText(R.string.download_cancel)) }
    }
    if (confirming && canCancel) AlertDialog(
        onDismissRequest = { confirming = false }, title = { Text(mobileText(R.string.download_cancel_question)) },
        text = { Text(mobileText(R.string.download_cancel_message, record.name), Modifier.verticalScroll(rememberScrollState())) },
        confirmButton = { TextButton(onClick = { confirming = false; perform(DownloadUiAction.Cancel) }, modifier = Modifier.testTag("confirm-download-cancel")) {
            Text(mobileText(R.string.download_cancel), color = MaterialTheme.colorScheme.error)
        } },
        dismissButton = { TextButton(onClick = { confirming = false }) { Text(mobileText(R.string.download_keep)) } },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ResourceActionsSheet(menu: ResourceMenuUi, records: List<DownloadRecord>?, onAction: ((DownloadUiAction, String) -> Unit)?, close: () -> Unit) {
    val resource = menu.resource
    val record = records?.firstOrNull { it.resourceId == resource.optString("resourceId") && it.revision == resource.optString("revision") && it.state != CANCELLED }
    val completed = record?.state == COMPLETED && record.uri != null
    val name = resource.getString("name")
    val mime = resource.optString("mimeType")
    val bytes = record?.totalBytes ?: resource.optLong("sizeBytes", -1L)
    val large = bytes > MobileFiles.MAX_BYTES
    val previewable = bytes <= PreviewPolicy.MAX_FILE_BYTES && PreviewPolicy.kind(name, mime) != null
    val installable = ApkInstall.matches(name, mime)
    val select: (Int) -> Unit = { action -> close(); menu.onSelect(action) }
    ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = 20.dp).testTag("resource-actions")) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(mobileText(R.string.download_file_actions), Modifier.weight(1f).padding(horizontal = 12.dp).semantics { heading() }, style = MaterialTheme.typography.titleMedium)
                IconButton(onClick = close) { Icon(Icons.Outlined.Close, mobileText(R.string.review_close)) }
            }
            Row(Modifier.padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                FileGlyph(mime)
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    Text(name, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold,
                        color = MaterialTheme.colorScheme.onSurface, maxLines = 3, overflow = TextOverflow.Ellipsis)
                    if (bytes >= 0) {
                        val size = Formatter.formatShortFileSize(LocalContext.current, bytes)
                        Text(if (completed) mobileText(R.string.download_saved_size, size) else size,
                            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            if (records == null) {
                LinearProgressIndicator(Modifier.fillMaxWidth().padding(vertical = 8.dp))
                Text(mobileText(R.string.downloads_loading), Modifier.padding(horizontal = 12.dp), style = MaterialTheme.typography.bodySmall)
                return@Column
            }
            if (record != null && !completed) {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) { DownloadProgress(record) }
                DownloadControls(record, onAction)
                return@Column
            }
            if (completed) {
                if (installable) ActionRow(mobileText(R.string.install_apk), Icons.Outlined.InstallMobile, tag = "install-apk") { select(R.string.install_apk) }
                else ActionRow(mobileText(R.string.open_other_app), Icons.Outlined.OpenInNew) { select(R.string.open_other_app) }
            }
            if (previewable) ActionRow(mobileText(R.string.preview_action), Icons.Outlined.Visibility) { select(R.string.preview_action) }
            if (record == null) {
                Button(onClick = { menu.onSelect(R.string.download_file) }, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp).testTag("download-file"), shape = MaterialTheme.shapes.medium) {
                    Icon(Icons.Outlined.Download, null, Modifier.size(20.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(mobileText(R.string.download_file))
                }
            }
            if (large && !completed) {
                if (record == null) ActionRow(mobileText(R.string.download_choose_folder), Icons.Outlined.FolderOpen) { select(R.string.download_choose_folder) }
            } else {
                ActionRow(mobileText(R.string.save_to_files), Icons.Outlined.SaveAlt) { select(R.string.save_to_files) }
                ActionRow(mobileText(R.string.share_file_title), Icons.Outlined.Share) { select(R.string.share_file_title) }
                if (previewable && !completed) ActionRow(mobileText(R.string.open_other_app), Icons.Outlined.OpenInNew) { select(R.string.open_other_app) }
            }
        }
    }
}
