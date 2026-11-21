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
internal fun ComposerToolbar(state: MobileUiState, onAction: (MobileAction, JSONObject?) -> Unit, attachments: () -> Unit, stopping: Boolean, active: List<JSONObject>, runs: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val muted = colors.onSurfaceVariant
    val fullAccess = state.executionSelection.optString("executionProfile") == "full_access"
    Row(Modifier.fillMaxWidth().testTag("composer-toolbar"), verticalAlignment = Alignment.CenterVertically) {
        ComposerButton(mobileText(R.string.label_add_attachment), "composer-attach", state.inputEnabled, attachments) {
            Icon(desktopSymbol(DesktopSymbol.Add), null, Modifier.size(20.dp), tint = muted)
        }
        ComposerButton(mobileText(R.string.permissions_summary, state.executionLabel), "composer-permission", state.executionEnabled, { onAction(MobileAction.ChooseExecution, null) }) {
            Icon(executionIcon(state.executionSelection), null, Modifier.size(18.dp), tint = if (fullAccess) colors.tertiary else muted)
        }
        Box(Modifier.weight(1f), contentAlignment = Alignment.CenterEnd) {
            TextButton(
                onClick = { onAction(MobileAction.ChooseModel, null) }, enabled = state.configEnabled && state.inputEnabled,
                shape = RoundedCornerShape(6.dp), contentPadding = PaddingValues(horizontal = 8.dp),
                modifier = Modifier.heightIn(min = 48.dp).testTag("model"),
            ) {
                Text(state.modelLabel, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.labelMedium, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Spacer(Modifier.width(4.dp))
                Icon(desktopSymbol(DesktopSymbol.ChevronDown), null, Modifier.size(14.dp), tint = muted)
            }
        }
        if (active.isNotEmpty()) {
            val target = active.singleOrNull()
            androidx.compose.runtime.key(active.map { it.optString("id") to it.opt("generation") }) {
                ComposerButton(if (stopping) mobileText(R.string.label_stopping) else mobileText(R.string.label_stop_reply), "stop-run", state.connected && !stopping, {
                    if (target != null) onAction(MobileAction.StopRun, target) else runs()
                }, surfaceSize = 32.dp) {
                    Box(Modifier.size(32.dp).clip(RoundedCornerShape(6.dp)).background(colors.secondaryContainer), contentAlignment = Alignment.Center) {
                        if (stopping) CircularProgressIndicator(Modifier.size(16.dp), color = colors.onSecondaryContainer, strokeWidth = 1.5.dp)
                        else Icon(Icons.Outlined.Stop, null, Modifier.size(18.dp), tint = colors.onSecondaryContainer)
                    }
                }
            }
        }
        val choosePermission = state.choosePermissionToSend
        val enabled = state.sendEnabled || choosePermission
        ComposerButton(mobileText(if (choosePermission) R.string.choose_task_permissions else R.string.label_send), "send", enabled, {
            onAction(if (choosePermission) MobileAction.ChooseExecution else MobileAction.Send, null)
        }, surfaceSize = 32.dp) {
            Box(Modifier.size(32.dp).clip(RoundedCornerShape(6.dp)).background(if (enabled) colors.primary else colors.surfaceVariant), contentAlignment = Alignment.Center) {
                if (state.submittingInput) CircularProgressIndicator(Modifier.size(16.dp), color = muted, strokeWidth = 1.5.dp)
                else Icon(desktopSymbol(DesktopSymbol.ArrowUp), null, Modifier.size(18.dp), tint = if (enabled) colors.onPrimary else muted)
            }
        }
    }
}

@Composable
private fun ComposerButton(label: String, tag: String, enabled: Boolean, action: () -> Unit, surfaceSize: Dp = 40.dp, content: @Composable () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Box(
        Modifier.width(48.dp).height(48.dp).alpha(if (enabled) 1f else .38f).testTag(tag)
            .semantics(mergeDescendants = true) { contentDescription = label }
            .clickable(interactionSource = interaction, indication = null, enabled = enabled, role = Role.Button, onClick = action),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(surfaceSize).clip(RoundedCornerShape(6.dp)).indication(interaction, ripple()), contentAlignment = Alignment.Center) { content() }
    }
}
