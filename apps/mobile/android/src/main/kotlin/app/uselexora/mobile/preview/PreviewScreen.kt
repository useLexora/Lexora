package app.uselexora.mobile.preview

import android.text.format.Formatter
import android.widget.FrameLayout
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.ui.HeaderAction

@OptIn(ExperimentalComposeUiApi::class)
@Composable
internal fun PreviewScreen(
    name: String, mime: String, size: Long, kind: PreviewKind, content: FrameLayout,
    loading: Boolean, error: String?, notice: String?, empty: Boolean,
    page: Int, pageCount: Int, chromeVisible: Boolean, canFollowup: Boolean,
    feedback: String?, feedbackShown: (String) -> Unit,
    back: () -> Unit, retry: () -> Unit, navigate: (Int) -> Unit,
    save: () -> Unit, share: () -> Unit, openWith: () -> Unit, followup: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    var information by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(feedback) {
        feedback?.let { snackbar.showSnackbar(it); feedbackShown(it) }
    }
    Surface(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }, color = MaterialTheme.colorScheme.background) {
        Box(Modifier.fillMaxSize().safeDrawingPadding()) {
            Column(Modifier.fillMaxSize()) {
                Box(Modifier.fillMaxWidth().height(64.dp)) {
                    if (chromeVisible) Row(
                        Modifier.fillMaxSize().padding(horizontal = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        HeaderAction(mobileText(R.string.label_back), Icons.AutoMirrored.Outlined.ArrowBack, action = back)
                        Box(Modifier.weight(1f).heightIn(min = 48.dp).clickable(role = Role.Button) { information = true }.padding(horizontal = 8.dp), contentAlignment = Alignment.CenterStart) {
                            Text(name, Modifier.testTag("preview-title"), style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        }
                        Box {
                            HeaderAction(mobileText(R.string.more_options), Icons.Outlined.MoreHoriz, Modifier.testTag("preview-more")) { menu = true }
                            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, containerColor = MaterialTheme.colorScheme.surfaceContainerHigh) {
                                DropdownMenuItem(text = { Text(mobileText(R.string.save_file)) }, leadingIcon = { Icon(Icons.Outlined.FileDownload, null) }, onClick = { menu = false; save() })
                                DropdownMenuItem(text = { Text(mobileText(R.string.share_file)) }, leadingIcon = { Icon(Icons.Outlined.Share, null) }, onClick = { menu = false; share() })
                                DropdownMenuItem(text = { Text(mobileText(R.string.open_other_app)) }, leadingIcon = { Icon(Icons.Outlined.OpenInNew, null) }, onClick = { menu = false; openWith() })
                                DropdownMenuItem(text = { Text(mobileText(R.string.preview_file_info)) }, leadingIcon = { Icon(Icons.Outlined.Info, null) }, onClick = { menu = false; information = true })
                            }
                        }
                    }
                }
                if (notice != null) Text(
                    notice, Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp).semantics { liveRegion = LiveRegionMode.Polite },
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Box(Modifier.weight(1f).fillMaxWidth().then(if (!loading && error == null) Modifier.testTag("preview-ready") else Modifier)) {
                    AndroidView(factory = { content }, modifier = Modifier.fillMaxSize().padding(horizontal = if (kind == PreviewKind.TEXT) 0.dp else 12.dp))
                    if (loading || error != null || empty) Column(
                        Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background).padding(28.dp).semantics { liveRegion = LiveRegionMode.Polite },
                        horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp, Alignment.CenterVertically),
                    ) {
                        if (loading) CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp)
                        else Icon(Icons.Outlined.InsertDriveFile, null, Modifier.size(32.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(error ?: mobileText(if (loading) R.string.opening_file else R.string.preview_empty_text), style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                        if (error != null) TextButton(onClick = retry, modifier = Modifier.testTag("preview-retry")) { Text(mobileText(R.string.label_retry)) }
                    }
                }
                if (kind == PreviewKind.PDF) Row(
                    Modifier.fillMaxWidth().padding(top = 4.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = { navigate(page - 1) }, enabled = !loading && page > 0, modifier = Modifier.size(48.dp).testTag("preview-previous")) {
                        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowLeft, mobileText(R.string.previous_page))
                    }
                    Text("${page + 1} / $pageCount", Modifier.padding(horizontal = 20.dp).testTag("preview-page"), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    IconButton(onClick = { navigate(page + 1) }, enabled = !loading && page + 1 < pageCount, modifier = Modifier.size(48.dp).testTag("preview-next")) {
                        Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, mobileText(R.string.next_page))
                    }
                }
                if (canFollowup) Box(Modifier.fillMaxWidth().heightIn(min = 72.dp).padding(12.dp), contentAlignment = Alignment.Center) {
                    if (chromeVisible) FilledTonalButton(onClick = followup, modifier = Modifier.heightIn(min = 48.dp).testTag("preview-followup"), contentPadding = PaddingValues(horizontal = 24.dp, vertical = 12.dp)) {
                        Icon(Icons.Outlined.Edit, null, Modifier.size(18.dp))
                        Spacer(Modifier.width(8.dp))
                        Text(mobileText(R.string.file_followup))
                    }
                }
            }
            SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).padding(12.dp))
        }
    }
    if (information) AlertDialog(
        onDismissRequest = { information = false },
        title = { Text(mobileText(R.string.preview_file_info)) },
        text = {
            SelectionContainer {
                Column(Modifier.heightIn(max = 360.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text(name, style = MaterialTheme.typography.bodyLarge)
                    Text(Formatter.formatFileSize(LocalContext.current, size), style = MaterialTheme.typography.bodyMedium)
                    if (mime.isNotBlank()) Text(mime, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        },
        confirmButton = { TextButton(onClick = { information = false }) { Text(mobileText(R.string.review_close)) } },
    )
}
