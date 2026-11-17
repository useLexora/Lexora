package app.uselexora.mobile.ui

import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
internal fun PairingStatusPanel(state: MobileUiState, action: (MobileAction) -> Unit) {
    val phase = state.pairingPhase ?: return
    val failure = state.pairingError.ifBlank { if (phase == "syncing") state.syncFailure else "" }
    val ready = phase == "ready"
    val failed = phase == "failed" || failure.isNotBlank()
    ModalBottomSheet(onDismissRequest = { action(MobileAction.ClosePairing) }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Column(Modifier.fillMaxWidth().padding(24.dp).testTag("pairing-status"), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                when { ready -> Icon(Icons.Outlined.CheckCircle, null, tint = MaterialTheme.colorScheme.primary); failed -> Icon(Icons.Outlined.ErrorOutline, null, tint = MaterialTheme.colorScheme.error); else -> CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp) }
                Text(mobileText(R.string.mobile_pairing_title), style = MaterialTheme.typography.titleLarge)
            }
            Text(mobileText(when { ready -> R.string.mobile_pairing_done; phase == "failed" -> R.string.mobile_pairing_failed; phase == "syncing" -> R.string.mobile_pairing_sync; else -> R.string.mobile_pairing_wait }))
            if (phase == "syncing" && !ready && state.connectionLabel.isNotBlank()) Text(state.connectionLabel, style = MaterialTheme.typography.bodySmall)
            if (failure.isNotBlank()) Text(failure, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
            Text(mobileText(R.string.mobile_pairing_close_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            FlowRow(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                if (phase == "failed") TextButton(onClick = { action(MobileAction.ClosePairing); action(MobileAction.ScanDevice) }) { Text(mobileText(R.string.label_scan_to_connect)) }
                if (phase == "syncing" && (failed || !state.connected)) TextButton(onClick = { action(if (state.connected) MobileAction.Refresh else MobileAction.Reconnect) }) { Text(mobileText(R.string.label_retry)) }
                TextButton(onClick = { action(MobileAction.ClosePairing) }) { Text(mobileText(R.string.review_close)) }
            }
        }
    }
}
