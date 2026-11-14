package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.MobileStrings
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ConversationMessageMenu(menu: MobileMessageMenu, connected: Boolean, onAction: (MobileAction, JSONObject?) -> Unit, close: () -> Unit) {
    val assistant = menu.message.optString("role") == "assistant"
    val time = runCatching { Instant.parse(menu.message.optString("createdAt")).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofLocalizedDateTime(java.time.format.FormatStyle.MEDIUM).withLocale(MobileStrings.locale)) }.getOrNull()
    ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxWidth().padding(start = 20.dp, end = 20.dp, bottom = 24.dp).testTag("message-menu")) {
            Text(if (assistant) mobileText(R.string.label_reply) else if (menu.message.optString("role") == "user") mobileText(R.string.label_your_message) else mobileText(R.string.label_tool_record), Modifier.padding(horizontal = 12.dp), style = MaterialTheme.typography.titleMedium)
            if (time != null) Text(time, Modifier.padding(horizontal = 12.dp, vertical = 8.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(8.dp))
            if (menu.canCopy) ActionRow(mobileText(R.string.label_copy), Icons.Outlined.ContentCopy) { onAction(MobileAction.CopyMessage, null) }
            if (menu.needsDetail) ActionRow(mobileText(R.string.label_load_full_content), Icons.Outlined.Article, enabled = connected) { onAction(MobileAction.OpenMessageDetail, null) }
            if (menu.canEdit) ActionRow(mobileText(R.string.label_edit), Icons.Outlined.Edit, mobileText(R.string.label_sending_your_edit_creates_a_new_branch), enabled = connected) { onAction(MobileAction.EditMessage, null) }
            if (assistant && menu.canRegenerate) ActionRow(mobileText(R.string.label_regenerate), Icons.Outlined.Refresh, mobileText(R.string.label_keep_the_original_reply_and_start_a_new_branch), enabled = connected, tag = "regenerate-message") { onAction(MobileAction.RegenerateMessage, null) }
            if (assistant && menu.run?.optString("status") == "completed") ActionRow(mobileText(R.string.label_continue_from_here), Icons.Outlined.ForkRight, enabled = connected) { onAction(MobileAction.ContinueMessage, null) }
            if (menu.run != null) ActionRow(mobileText(R.string.label_run_details), Icons.Outlined.Info, enabled = connected) { onAction(MobileAction.ShowMessageRun, null) }
            if (menu.loading) LinearProgressIndicator(Modifier.fillMaxWidth().padding(12.dp))
        }
    }
}
