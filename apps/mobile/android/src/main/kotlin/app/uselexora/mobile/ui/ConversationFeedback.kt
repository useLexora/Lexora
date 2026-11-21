package app.uselexora.mobile.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalAccessibilityManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText
import kotlinx.coroutines.delay

@Composable
internal fun ConversationFeedbackLayer(
    state: MobileUiState,
    connectionNotice: Boolean,
    visible: Boolean,
    onAction: (MobileAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    val messages = listOfNotNull(
        state.sendFeedback,
        state.notice.takeUnless { connectionNotice },
        state.inputFeedback.takeUnless { it == mobileText(R.string.mobile_saved_on_phone) },
    ).filter { it.isNotBlank() }.distinct()
    var dismissed by remember { mutableStateOf(emptySet<String>()) }
    if (dismissed.any { it !in messages }) SideEffect { dismissed = dismissed.intersect(messages.toSet()) }
    val message = messages.firstOrNull { it !in dismissed } ?: return
    if (!visible) return

    BoxWithConstraints(modifier, contentAlignment = Alignment.TopCenter) {
        if (maxHeight < 48.dp) return@BoxWithConstraints
        val checkReceipt = message == state.sendFeedback && state.canCheckInputReceipt
        val dismiss: () -> Unit = {
            dismissed = dismissed + message
            if (message == state.notice) onAction(MobileAction.DismissNotice)
        }
        val currentDismiss by rememberUpdatedState(dismiss)
        val baseTimeout = if (checkReceipt) 8000L else 4000L
        val timeout = LocalAccessibilityManager.current?.calculateRecommendedTimeoutMillis(
            originalTimeoutMillis = baseTimeout, containsIcons = true, containsText = true, containsControls = true,
        ) ?: baseTimeout
        LaunchedEffect(message, timeout) { delay(timeout); currentDismiss() }

        val colors = MaterialTheme.colorScheme
        Surface(
            modifier = Modifier.widthIn(max = 560.dp).fillMaxWidth().padding(horizontal = 8.dp)
                .padding(top = if (maxHeight >= 56.dp) 4.dp else 0.dp).testTag("conversation-feedback"),
            color = colors.inverseSurface, contentColor = colors.inverseOnSurface,
            shape = MaterialTheme.shapes.medium, shadowElevation = 2.dp,
        ) {
            Row(Modifier.padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                key(message) {
                    Text(message, modifier = Modifier.weight(1f).heightIn(max = 120.dp).verticalScroll(rememberScrollState())
                        .padding(vertical = 6.dp).semantics { liveRegion = LiveRegionMode.Polite },
                        style = MaterialTheme.typography.bodyMedium)
                }
                if (checkReceipt) TextButton(
                    onClick = { onAction(MobileAction.CheckInputReceipt) }, modifier = Modifier.heightIn(min = 48.dp),
                    contentPadding = PaddingValues(horizontal = 8.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = colors.inversePrimary),
                ) { Text(mobileText(R.string.send_check_status)) }
                IconButton(onClick = dismiss, modifier = Modifier.size(48.dp)) {
                    Icon(Icons.Outlined.Close, mobileText(R.string.label_dismiss_notice), Modifier.size(18.dp))
                }
            }
        }
    }
}
