package app.uselexora.mobile.ui

import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import org.json.JSONObject

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TaskMembersPanel(state: MobileUiState, action: (MobileAction, JSONObject?) -> Unit) {
    val snapshot = state.members
    val array = snapshot?.optJSONArray("items")
    val members = if (array == null) emptyList() else (0 until array.length()).map { array.getJSONObject(it) }
    val ids = members.map { it.getString("actorId") }.toSet()
    val duplicateNames = (members.map { it.getJSONObject("profile") } + state.buddyCatalog).distinctBy { it.getString("id") }.groupingBy { it.getString("name") }.eachCount().filterValues { it > 1 }.keys
    ModalBottomSheet(onDismissRequest = { state.membersOpen = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.background) {
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 600.dp).testTag("task-members"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item {
                Text(mobileText(R.string.mobile_task_members), style = MaterialTheme.typography.titleLarge)
                Text(mobileText(R.string.mobile_partner_scope), Modifier.padding(vertical = 8.dp), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (state.membersLoading || state.membersChanging) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            if (state.membersError.isNotBlank()) item { DiscoveryNotice(state.membersError) { action(MobileAction.ShowMembers, null) } }
            items(members, key = { it.getString("actorId") }) { member ->
                val profile = member.getJSONObject("profile")
                val lead = snapshot?.optString("buddyId") == member.getString("actorId")
                val available = profile.optBoolean("enabled") && !profile.optBoolean("deleted")
                Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.surfaceContainerHigh) {
                    Column(Modifier.padding(16.dp)) {
                        Text(profile.getString("name"), style = MaterialTheme.typography.titleMedium)
                        if (profile.getString("name") in duplicateNames) Text(profile.getString("id"), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (lead) Text(mobileText(R.string.mobile_current_partner), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                        if (!available) Text(mobileText(R.string.mobile_partner_disabled), style = MaterialTheme.typography.bodySmall)
                        if (profile.optString("description").isNotBlank()) Text(profile.getString("description"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        val selection = member.optJSONObject("modelSelection")
                        val source = when (member.optString("modelSelectionSource")) {
                            "explicit" -> R.string.mobile_partner_model_explicit
                            "snapshot", "legacy" -> R.string.mobile_partner_model_snapshot
                            else -> R.string.mobile_partner_model_default
                        }
                        Text(mobileText(source) + (selection?.optString("modelId")?.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (!lead) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                            TextButton(onClick = { action(MobileAction.RemoveMember, member) }, enabled = MobileAction.RemoveMember in state.memberActions && state.connected && state.conversationReady && !state.membersChanging && !state.viewingArchived) { Text(mobileText(R.string.mobile_remove_partner)) }
                            TextButton(onClick = { action(MobileAction.SelectBuddy, member) }, enabled = MobileAction.SelectBuddy in state.memberActions && available && state.connected && state.conversationReady && !state.membersChanging && !state.viewingArchived) { Text(mobileText(R.string.mobile_make_lead)) }
                        }
                    }
                }
            }
            val candidates = state.buddyCatalog.filter { it.getString("id") !in ids && it.optBoolean("enabled") && !it.optBoolean("deleted") }
            if (candidates.isNotEmpty() && !state.viewingArchived) item { Text(mobileText(R.string.mobile_add_partner), style = MaterialTheme.typography.titleSmall) }
            if (!state.viewingArchived) items(candidates, key = { "candidate:${it.getString("id")}" }) { candidate ->
                ActionRow(candidate.getString("name"), Icons.Outlined.PersonAdd, listOfNotNull(candidate.optString("description").takeIf { it.isNotBlank() }, candidate.getString("id").takeIf { candidate.getString("name") in duplicateNames }).joinToString(" · "), enabled = MobileAction.AddMember in state.memberActions && state.connected && state.conversationReady && !state.membersChanging) { action(MobileAction.AddMember, candidate) }
            }
        }
    }
}
