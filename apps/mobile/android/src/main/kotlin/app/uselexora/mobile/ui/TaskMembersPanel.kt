package app.uselexora.mobile.ui

import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.json.JSONObject

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun TaskMembersPanel(state: MobileUiState, avatarContext: ReaderAvatars? = null, action: (MobileAction, JSONObject?) -> Unit) {
    val snapshot = state.members
    val array = snapshot?.optJSONArray("items")
    val members = if (array == null) emptyList() else (0 until array.length()).map { array.getJSONObject(it) }
    val ids = members.map { it.getString("actorId") }.toSet()
    val profiles = (members.map { it.getJSONObject("profile") } + state.buddyCatalog).distinctBy { it.getString("id") }
    val duplicateNames = profiles.groupingBy { it.getString("name") }.eachCount().filterValues { it > 1 }.keys
    val avatars = avatarContext
    val sources = rememberPartnerAvatars(avatars, state.topic, profiles.map { it.getString("id") }.toSet())
    val canChange = state.connected && state.conversationReady && !state.membersChanging && !state.viewingArchived
    val candidates = state.buddyCatalog.filter { it.getString("id") !in ids && it.optBoolean("enabled") && !it.optBoolean("deleted") }
    ModalBottomSheet(onDismissRequest = { state.membersOpen = false }, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.background) {
        LazyColumn(Modifier.fillMaxWidth().heightIn(max = 600.dp).testTag("task-members"), contentPadding = PaddingValues(start = 20.dp, end = 20.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(mobileText(R.string.mobile_task_members), Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                    IconButton(onClick = { state.membersOpen = false }) { Icon(Icons.Outlined.Close, mobileText(R.string.review_close)) }
                }
            }
            if (state.membersLoading || state.membersChanging) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
            if (state.membersError.isNotBlank()) item { DiscoveryNotice(state.membersError) { action(MobileAction.ShowMembers, null) } }
            items(members, key = { it.getString("actorId") }) { member ->
                val profile = member.getJSONObject("profile")
                val id = member.getString("actorId")
                val lead = snapshot?.optString("buddyId") == id
                val available = profile.optBoolean("enabled") && !profile.optBoolean("deleted")
                val modelName = MobileModelControls.model(member.optJSONObject("modelSelection"), state.models)?.optString("displayName")?.takeIf { it.isNotBlank() }
                var menu by remember(id) { mutableStateOf(false) }
                Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
                    Row(Modifier.heightIn(min = 72.dp).padding(start = 12.dp, end = 4.dp, top = 12.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        PartnerAvatar(id, profile.getString("name"), sources[id], avatars)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                            Text(profile.getString("name"), maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleSmall)
                            if (lead) Text(mobileText(R.string.mobile_current_partner), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
                            if (!available) Text(mobileText(R.string.mobile_partner_disabled), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            if (modelName != null) Text(modelName, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            if (profile.getString("name") in duplicateNames) Text(id, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (lead) Icon(Icons.Outlined.Check, null, Modifier.padding(12.dp).size(20.dp), tint = MaterialTheme.colorScheme.primary)
                        else Box {
                            IconButton(onClick = { menu = true }, modifier = Modifier.testTag("partner-actions-$id")) { Icon(Icons.Outlined.MoreHoriz, mobileText(R.string.more_options)) }
                            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                DropdownMenuItem(text = { Text(mobileText(R.string.mobile_make_lead)) }, enabled = canChange && available && MobileAction.SelectBuddy in state.memberActions,
                                    onClick = { menu = false; action(MobileAction.SelectBuddy, member) })
                                DropdownMenuItem(text = { Text(mobileText(R.string.mobile_remove_partner)) }, enabled = canChange && MobileAction.RemoveMember in state.memberActions,
                                    onClick = { menu = false; action(MobileAction.RemoveMember, member) })
                            }
                        }
                    }
                }
            }
            if (candidates.isNotEmpty() && !state.viewingArchived) item {
                Text(mobileText(R.string.mobile_add_partner), Modifier.padding(start = 4.dp, top = 12.dp, bottom = 4.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (!state.viewingArchived) items(candidates, key = { "candidate:${it.getString("id")}" }) { candidate ->
                val id = candidate.getString("id")
                Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).testTag("add-partner-$id")
                    .clickable(enabled = canChange && MobileAction.AddMember in state.memberActions, role = Role.Button) { action(MobileAction.AddMember, candidate) }
                    .padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    PartnerAvatar(id, candidate.getString("name"), sources[id], avatars)
                    Column(Modifier.weight(1f)) {
                        Text(candidate.getString("name"), maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyLarge)
                        val detail = if (candidate.getString("name") in duplicateNames) id else candidate.optString("description")
                        if (detail.isNotBlank()) Text(detail, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Icon(Icons.Outlined.Add, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.primary)
                }
            }
        }
    }
}
