package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.indication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.uselexora.mobile.R
import app.uselexora.mobile.session.MobileConnectionPhase
import org.json.JSONObject

@Composable
private fun ServiceConnectButton(device: MobileDeviceItem, onClick: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    val shape = RoundedCornerShape(6.dp)
    val description = mobileText(R.string.service_connect_named, device.label)
    Box(Modifier.heightIn(min = 48.dp).widthIn(min = 48.dp).testTag("connect-service-${device.id}")
        .semantics(mergeDescendants = true) { contentDescription = description }
        .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick)
        .padding(vertical = 8.dp), contentAlignment = Alignment.Center) {
        Surface(modifier = Modifier.heightIn(min = 32.dp).testTag("service-action-surface-${device.id}").clip(shape).indication(interaction, ripple()), shape = shape,
            color = MaterialTheme.colorScheme.secondaryContainer, contentColor = MaterialTheme.colorScheme.onSecondaryContainer) {
            Box(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), contentAlignment = Alignment.Center) {
                Text(mobileText(R.string.service_connect), style = MaterialTheme.typography.labelMedium)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ServiceSwitcher(state: MobileUiState, onAction: (MobileAction, JSONObject?) -> Unit, close: () -> Unit) {
    val hasCurrentService = state.devices.any { it.selected }
    ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.background) {
        Column(Modifier.fillMaxWidth().testTag("service-switcher")) {
            Row(Modifier.fillMaxWidth().padding(start = 24.dp, end = 12.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(mobileText(R.string.label_connect_service), Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                IconButton(onClick = { close(); onAction(MobileAction.ShowDevices, null) }, modifier = Modifier.testTag("manage-services")) { Icon(Icons.Outlined.Settings, mobileText(R.string.label_manage_services), Modifier.size(21.dp)) }
                IconButton(onClick = { close(); onAction(MobileAction.ScanDevice, null) }, modifier = Modifier.testTag("scan-service")) { Icon(Icons.Outlined.QrCodeScanner, mobileText(R.string.label_scan_to_connect_alternate), Modifier.size(21.dp)) }
            }
            if (state.devices.isEmpty()) {
                Box(Modifier.fillMaxWidth().weight(1f, fill = false).height(240.dp).testTag("service-empty-area"), contentAlignment = Alignment.Center) {
                    Column(Modifier.padding(horizontal = 24.dp).testTag("service-empty-message"), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(mobileText(R.string.label_no_saved_services), style = MaterialTheme.typography.titleSmall, textAlign = TextAlign.Center)
                        Text(mobileText(R.string.label_scan_a_qr_code_to_connect_to_lexora), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
                    }
                }
            } else {
                LazyColumn(Modifier.weight(1f, fill = false).heightIn(max = 440.dp), contentPadding = PaddingValues(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    items(state.devices, key = { it.id }) { device ->
                        val connecting = device.selected && !device.connected && state.connectionPhase in setOf(MobileConnectionPhase.Connecting, MobileConnectionPhase.Retrying)
                        val shape = RoundedCornerShape(12.dp)
                        val switching = hasCurrentService && !device.selected
                        val description = mobileText(if (switching) R.string.service_switch_named else R.string.service_connect_named, device.label)
                        val connect = { close(); onAction(MobileAction.SelectDevice, JSONObject().put("id", device.id)) }
                        Surface(modifier = Modifier.fillMaxWidth().testTag("service-${device.id}").semantics { selected = device.selected }
                            .then(if (device.selected) Modifier else Modifier.clip(shape).semantics { contentDescription = description }.clickable(role = Role.Button, onClick = connect)),
                            shape = shape, color = MaterialTheme.colorScheme.surfaceContainer,
                            border = BorderStroke(if (device.selected) 1.5.dp else .75.dp, if (device.selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant)) {
                            Row(Modifier.padding(start = 16.dp, end = 12.dp, top = 12.dp, bottom = 12.dp).heightIn(min = 48.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                Box(Modifier.size(40.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.background.copy(alpha = .7f)), contentAlignment = Alignment.Center) {
                                    ServiceIcon(Modifier.size(21.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                Text(device.label, Modifier.weight(1f).testTag("service-name-${device.id}"), style = MaterialTheme.typography.titleSmall, maxLines = 2, overflow = TextOverflow.Ellipsis)
                                when {
                                    device.connected -> Row(Modifier.testTag("service-status-${device.id}"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                        Icon(Icons.Outlined.CheckCircle, null, Modifier.size(16.dp), tint = MaterialTheme.colorScheme.secondary)
                                        Text(mobileText(R.string.label_connected), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.secondary)
                                    }
                                    connecting -> Row(Modifier.testTag("service-status-${device.id}"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                        CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp)
                                        Text(mobileText(R.string.service_connecting), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                    device.selected -> ServiceConnectButton(device, connect)
                                    else -> Text(mobileText(if (switching) R.string.service_switch else R.string.service_connect), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
