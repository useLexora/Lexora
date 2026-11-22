package app.uselexora.mobile.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.PlaylistPlay
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileQuantity
import app.uselexora.mobile.i18n.mobileText
import org.json.JSONObject

internal enum class ConversationTodo(val tag: String, val action: MobileAction, val countLabel: Int) {
    Unanswered("answer-question", MobileAction.AnswerQuestion, R.plurals.inbox_unanswered),
    Undelivered("review-undelivered-result", MobileAction.AnswerQuestion, R.plurals.inbox_undelivered),
    Approval("review-approval", MobileAction.ReviewApproval, R.plurals.inbox_approval);

    fun items(state: MobileUiState): List<JSONObject> = when (this) {
        Unanswered -> if (state.questionsSupported) state.questions.filter { it.optString("status") == "pending" } else emptyList()
        Undelivered -> if (state.questionsSupported) state.questions.filter {
            when (it.optString("status")) {
                "answered", "cancelled" -> it.optJSONObject("delivery")?.optString("state") == "failed"
                else -> false
            }
        } else emptyList()
        Approval -> state.approvalItems.filter { it.optString("status") == "pending" }
    }
}

internal fun questionSummary(request: JSONObject) = request.optJSONArray("questions")?.optJSONObject(0)?.optString("question")?.takeIf { it.isNotBlank() } ?: mobileText(R.string.label_view_and_answer)

@Composable
internal fun ConversationInboxActions(state: MobileUiState, compact: Boolean, onAction: (MobileAction, JSONObject?) -> Unit, openGroup: (ConversationTodo) -> Unit) {
    for (group in ConversationTodo.entries) {
        val items = group.items(state)
        val first = items.firstOrNull() ?: continue
        TextButton(
            onClick = { if (items.size == 1) onAction(group.action, first) else openGroup(group) },
            enabled = state.connected,
            modifier = Modifier.heightIn(min = 48.dp).testTag(group.tag),
        ) {
            Column {
                Text(mobileQuantity(group.countLabel, items.size))
                if (!compact && items.size == 1) {
                    val summary = if (group == ConversationTodo.Approval) first.optString("summary") else questionSummary(first)
                    if (summary.isNotBlank()) Text(summary, Modifier.widthIn(max = 200.dp), style = MaterialTheme.typography.bodySmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
    val waiting = state.queueItems.count { it.optString("state") == "waiting" }
    val paused = state.queueItems.count { it.optString("state") == "paused" }
    if (waiting > 0 || paused > 0) TextButton(onClick = { onAction(MobileAction.TaskQueue, null) }, modifier = Modifier.heightIn(min = 48.dp).testTag("conversation-queue")) {
        Icon(Icons.Outlined.PlaylistPlay, mobileText(R.string.label_queued_messages), Modifier.size(20.dp))
        Text(listOfNotNull(
            if (waiting > 0) mobileQuantity(R.plurals.inbox_waiting, waiting) else null,
            if (paused > 0) mobileQuantity(R.plurals.inbox_paused, paused) else null,
        ).joinToString(" · "), Modifier.padding(start = 6.dp))
    }
}
