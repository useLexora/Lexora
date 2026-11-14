package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R

import androidx.compose.foundation.clickable
import androidx.compose.foundation.indication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import org.json.JSONObject

@Composable
internal fun ComposerToolbar(state: MobileUiState, onAction: (MobileAction, JSONObject?) -> Unit, attachments: () -> Unit, stop: Boolean, stopping: Boolean, active: List<JSONObject>, runs: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val muted = colors.onSurfaceVariant
    val fullAccess = state.executionSelection.optString("executionProfile") == "full_access"
    Row(Modifier.fillMaxWidth().testTag("composer-toolbar"), verticalAlignment = Alignment.CenterVertically) {
        ComposerButton(mobileText(R.string.label_add_attachment), "composer-attach", state.inputEnabled, attachments) {
            Icon(Icons.Outlined.Add, null, Modifier.size(20.dp), tint = muted)
        }
        ComposerButton(mobileText(R.string.permissions_summary, state.executionLabel), "composer-permission", state.executionEnabled, { onAction(MobileAction.ChooseExecution, null) }) {
            val icon = when {
                fullAccess -> Icons.Outlined.LockOpen
                state.executionSelection.optString("executionProfile") == "read_only" -> Icons.Outlined.Lock
                state.executionSelection.optString("approvalPolicy") == "manual" -> Icons.Outlined.VerifiedUser
                else -> Icons.Outlined.Shield
            }
            Icon(icon, null, Modifier.size(18.dp), tint = if (fullAccess) colors.tertiary else muted)
        }
        Box(Modifier.weight(1f)) {
            TextButton(
                onClick = { onAction(MobileAction.ChooseReasoning, null) }, enabled = state.configEnabled && state.inputEnabled,
                shape = RoundedCornerShape(6.dp), contentPadding = PaddingValues(horizontal = 8.dp),
                modifier = Modifier.heightIn(min = 48.dp).testTag("model"),
            ) {
                Text(state.modelLabel, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.labelMedium, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.width(4.dp))
                Icon(Icons.Outlined.ExpandMore, null, Modifier.size(14.dp), tint = muted)
            }
        }
        val enabled = if (stop) state.connected && !stopping else state.sendEnabled
        ComposerButton((if (stop) mobileText(R.string.label_stop_reply) else mobileText(R.string.label_send)), if (stop) "stop-run" else "send", enabled, {
            if (stop) { if (active.size == 1) onAction(MobileAction.StopRun, active.first()) else runs() }
            else onAction(MobileAction.Send, null)
        }, surfaceSize = 32.dp) {
            Box(Modifier.size(32.dp).clip(RoundedCornerShape(6.dp)).background(if (stop || state.sendEnabled) colors.primary else colors.surfaceVariant), contentAlignment = Alignment.Center) {
                if (stopping) CircularProgressIndicator(Modifier.size(16.dp), color = colors.onPrimary, strokeWidth = 1.5.dp)
                else Icon(if (stop) Icons.Outlined.Stop else Icons.Outlined.ArrowUpward, null, Modifier.size(18.dp), tint = if (stop || state.sendEnabled) colors.onPrimary else muted)
            }
        }
    }
}

@Composable
private fun ComposerButton(label: String, tag: String, enabled: Boolean, action: () -> Unit, surfaceSize: Dp = 40.dp, content: @Composable () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Box(
        Modifier.width(40.dp).height(48.dp).alpha(if (enabled) 1f else .38f).testTag(tag)
            .semantics(mergeDescendants = true) { contentDescription = label }
            .clickable(interactionSource = interaction, indication = null, enabled = enabled, role = Role.Button, onClick = action),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(surfaceSize).clip(RoundedCornerShape(6.dp)).indication(interaction, ripple()), contentAlignment = Alignment.Center) { content() }
    }
}
