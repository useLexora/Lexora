package app.uselexora.mobile.ui

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

internal fun confirmedLegacyReply(message: JSONObject, run: JSONObject?, transcript: JSONObject?): Boolean {
    if (message.optString("role") != "assistant" || run == null || transcript == null || !transcript.optBoolean("loaded") ||
        transcript.has("error") || !run.has("lastEventSequence") || transcript.optString("sequence") != run.optString("lastEventSequence")) return false
    val events = transcript.optJSONArray("events") ?: return false
    for (index in events.length() - 1 downTo 0) {
        val event = events.getJSONObject(index)
        if (event.optString("type") !in setOf("message.completed", "message.interrupted")) continue
        val payload = event.optJSONObject("payload") ?: continue
        if (payload.optString("role", "assistant") != "assistant") continue
        return payload.optString("messageId") == message.optString("id") && event.optString("runId") == message.optString("runId") &&
            (event.optString("type") == "message.interrupted" || payload.optString("phase") == "final_answer" ||
                (payload.isNull("phase") && payload.optString("stopReason") in setOf("completed", "length", "failed")))
    }
    return false
}

internal fun releasedReplyRun(run: JSONObject?, execution: JSONObject?) = run != null && execution != null &&
    run.has("id") && run.has("generation") && run.optString("id") == execution.optString("runId") && run.optString("generation") == execution.optString("generation") &&
    execution.optString("resources") == "released"

internal val MobileMessageMenu.hasMessageActions: Boolean get() =
    ((contextual || message.optString("role") == "tool") && canCopy) || (contextual && canEdit) || canFollowup || canRegenerate || needsDetail

@Composable
internal fun ConversationMessageMenu(menu: MobileMessageMenu, connected: Boolean, onAction: (MobileAction, JSONObject?) -> Unit, close: () -> Unit) {
    val margin = with(LocalDensity.current) { 8.dp.roundToPx() }
    val position = remember(menu.anchor, margin) { MessageMenuPosition(menu.anchor, margin) }
    Popup(popupPositionProvider = position, onDismissRequest = close, properties = PopupProperties(focusable = true)) {
        Surface(shape = RoundedCornerShape(12.dp), color = MaterialTheme.colorScheme.surface, tonalElevation = 2.dp, shadowElevation = 6.dp) {
            Column(Modifier.width(224.dp).padding(vertical = 6.dp).testTag("message-menu")) {
                if ((menu.contextual || menu.message.optString("role") == "tool") && menu.canCopy) DropdownMenuItem(
                    text = { Text(mobileText(R.string.label_copy), style = MaterialTheme.typography.bodyMedium) },
                    leadingIcon = { Icon(Icons.Outlined.ContentCopy, null, Modifier.size(18.dp)) },
                    onClick = { onAction(MobileAction.CopyMessage, null) },
                )
                if (menu.contextual && menu.canEdit) DropdownMenuItem(
                    text = { Text(mobileText(R.string.label_edit), style = MaterialTheme.typography.bodyMedium) },
                    leadingIcon = { Icon(Icons.Outlined.Edit, null, Modifier.size(18.dp)) },
                    enabled = connected,
                    onClick = { onAction(MobileAction.EditMessage, null) },
                )
                if (menu.canRegenerate) DropdownMenuItem(
                    text = { Text(mobileText(R.string.message_regenerate_reply), style = MaterialTheme.typography.bodyMedium) },
                    leadingIcon = { Icon(Icons.Outlined.Refresh, null, Modifier.size(18.dp)) },
                    enabled = connected,
                    onClick = { onAction(MobileAction.RegenerateMessage, null) },
                )
                if (menu.canFollowup) DropdownMenuItem(
                    text = { Text(mobileText(R.string.message_continue_from_reply), style = MaterialTheme.typography.bodyMedium) },
                    leadingIcon = { Icon(Icons.Outlined.ForkRight, null, Modifier.size(18.dp)) },
                    enabled = connected,
                    onClick = { onAction(MobileAction.ContinueMessage, null) },
                )
                if (menu.needsDetail) DropdownMenuItem(
                    text = { Text(mobileText(R.string.label_load_full_content), style = MaterialTheme.typography.bodyMedium) },
                    leadingIcon = { Icon(Icons.Outlined.Article, null, Modifier.size(18.dp)) },
                    enabled = connected,
                    onClick = { onAction(MobileAction.OpenMessageDetail, null) },
                )
                if (menu.loading) LinearProgressIndicator(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp))
            }
        }
    }
}
