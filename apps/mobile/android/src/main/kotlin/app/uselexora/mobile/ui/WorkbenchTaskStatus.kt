package app.uselexora.mobile.ui

import androidx.compose.foundation.layout.*
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.session.MobileConnectionPhase

internal val MobileUiState.workbenchServiceLabel: Int get() = when {
    connected -> R.string.label_connected
    connectionPhase == MobileConnectionPhase.Retrying || connectionPhase == MobileConnectionPhase.Connecting && tasksLoaded -> R.string.service_reconnecting
    connectionPhase == MobileConnectionPhase.Connecting -> R.string.service_connecting
    else -> R.string.service_offline
}

@Composable
internal fun WorkbenchTaskStatus(state: MobileUiState, modifier: Modifier, color: Color = MaterialTheme.colorScheme.onSurfaceVariant, retry: () -> Unit) {
    if (!state.connected) return
    val failure = when {
        state.taskSyncFailed -> R.string.mobile_task_update_failed
        state.marksFailed -> R.string.label_task_marks_could_not_sync_please_retry
        else -> null
    }
    val message = failure ?: if (!state.tasksLoaded) R.string.label_syncing_tasks else return
    Row(modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(mobileText(message), Modifier.weight(1f).semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.bodySmall, color = color)
        if (failure != null) TextButton(onClick = retry) { Text(mobileText(R.string.label_retry), color = color) }
    }
}
