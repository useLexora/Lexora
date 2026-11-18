package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.MobileStrings
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.*
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import org.json.JSONObject
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

internal class MessageMenuPosition(private val anchor: IntRect?, private val margin: Int) : PopupPositionProvider {
    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset {
        val target = anchor ?: anchorBounds
        val x = if (layoutDirection == LayoutDirection.Rtl) target.right - popupContentSize.width else target.left
        val below = target.bottom + margin
        val y = if (below + popupContentSize.height <= windowSize.height - margin) below else target.top - popupContentSize.height - margin
        return IntOffset(
            x.coerceIn(margin, (windowSize.width - popupContentSize.width - margin).coerceAtLeast(margin)),
            y.coerceIn(margin, (windowSize.height - popupContentSize.height - margin).coerceAtLeast(margin)),
        )
    }
}

@Composable
internal fun ConversationMessageMenu(menu: MobileMessageMenu, connected: Boolean, onAction: (MobileAction, JSONObject?) -> Unit, close: () -> Unit) {
    val time = runCatching { Instant.parse(menu.message.optString("createdAt")).atZone(ZoneId.systemDefault()).format(DateTimeFormatter.ofLocalizedDateTime(java.time.format.FormatStyle.MEDIUM).withLocale(MobileStrings.locale)) }.getOrNull()
    val margin = with(LocalDensity.current) { 8.dp.roundToPx() }
    val position = remember(menu.anchor, margin) { MessageMenuPosition(menu.anchor, margin) }
    Popup(popupPositionProvider = position, onDismissRequest = close, properties = PopupProperties(focusable = true)) {
        Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surface, tonalElevation = 2.dp, shadowElevation = 6.dp) {
            Column(Modifier.width(224.dp).padding(vertical = 6.dp).testTag("message-menu")) {
                if ((menu.contextual || menu.message.optString("role") == "tool") && menu.canCopy) DropdownMenuItem(
                    text = { Text(mobileText(R.string.label_copy), style = MaterialTheme.typography.bodyMedium) },
                    leadingIcon = { Icon(Icons.Outlined.ContentCopy, null, Modifier.size(18.dp)) },
                    onClick = { onAction(MobileAction.CopyMessage, null) },
                    modifier = Modifier.height(40.dp),
                )
                if (menu.contextual && menu.canEdit) DropdownMenuItem(
                    text = { Text(mobileText(R.string.label_edit), style = MaterialTheme.typography.bodyMedium) },
                    leadingIcon = { Icon(Icons.Outlined.Edit, null, Modifier.size(18.dp)) },
                    enabled = connected,
                    onClick = { onAction(MobileAction.EditMessage, null) },
                    modifier = Modifier.height(40.dp),
                )
                if (menu.contextual && menu.canRegenerate) DropdownMenuItem(
                    text = { Text(mobileText(R.string.label_regenerate), style = MaterialTheme.typography.bodyMedium) },
                    leadingIcon = { Icon(Icons.Outlined.Refresh, null, Modifier.size(18.dp)) },
                    enabled = connected,
                    onClick = { onAction(MobileAction.RegenerateMessage, null) },
                    modifier = Modifier.height(40.dp),
                )
                if (menu.contextual && menu.message.optString("role") == "assistant" && menu.run?.optString("status") == "completed") DropdownMenuItem(
                    text = { Text(mobileText(R.string.label_continue_from_here), style = MaterialTheme.typography.bodyMedium) },
                    leadingIcon = { Icon(Icons.Outlined.ForkRight, null, Modifier.size(18.dp)) },
                    enabled = connected,
                    onClick = { onAction(MobileAction.ContinueMessage, null) },
                    modifier = Modifier.height(40.dp),
                )
                if (menu.needsDetail) DropdownMenuItem(
                    text = { Text(mobileText(R.string.label_load_full_content), style = MaterialTheme.typography.bodyMedium) },
                    leadingIcon = { Icon(Icons.Outlined.Article, null, Modifier.size(18.dp)) },
                    enabled = connected,
                    onClick = { onAction(MobileAction.OpenMessageDetail, null) },
                    modifier = Modifier.height(40.dp),
                )
                if (menu.run != null) DropdownMenuItem(
                    text = { Text(mobileText(R.string.label_run_details), style = MaterialTheme.typography.bodyMedium) },
                    leadingIcon = { Icon(Icons.Outlined.Info, null, Modifier.size(18.dp)) },
                    enabled = connected,
                    onClick = { onAction(MobileAction.ShowMessageRun, null) },
                    modifier = Modifier.height(40.dp),
                )
                if (menu.loading) LinearProgressIndicator(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp))
                if (time != null) Text(time, Modifier.padding(horizontal = 16.dp, vertical = 6.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
