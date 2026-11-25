package app.uselexora.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import org.json.JSONObject

data class ComposerRun(
    val id: String, val generation: String, val status: String,
    val runningTool: Boolean, val runningReasoning: Boolean, val replying: Boolean,
    val awaitingApproval: Boolean = false, val awaitingAnswer: Boolean = false, val stopping: Boolean = false,
) {
    internal fun wire(request: Long): JSONObject = JSONObject().put("requestId", request.toString()).put("runId", id).put("status", status)
        .put("runningTool", runningTool).put("runningReasoning", runningReasoning).put("replying", replying)
        .put("awaitingApproval", awaitingApproval).put("awaitingAnswer", awaitingAnswer).put("stopping", stopping)
}

data class ComposerActivity(val topic: String, val source: ComposerRun, val label: String, val active: Boolean, val warning: Boolean)

internal fun projectComposerRuns(page: ConversationPage, conversationId: String, branchId: String): List<ComposerRun> {
    val runs = page.runs.filter { it.optString("conversationId") == conversationId && it.optString("branchId") == branchId &&
        it.optString("status") in setOf("running", "queued") && it.optString("executionKind", "root") in setOf("root", "actor_child") && it.optString("purpose") != "conversation.compaction" }
    if (runs.isEmpty()) return emptyList()
    val tools = page.groups.filter { it.optInt("runningCount") > 0 }.map { it.getString("runId") }.toSet()
    val reasoning = page.groups.filter { it.optInt("runningReasoningCount") > 0 }.map { it.getString("runId") }.toSet()
    val replies = page.messages.filter { message ->
        val range = message.optJSONObject("textRange")
        message.optString("role") == "assistant" && range != null && range.optString("revision").toLongOrNull() != null && range.optLong("total") > 0
    }.map { it.getString("runId") }.toSet()
    return runs.sortedWith(compareByDescending<JSONObject> { it.optString("startedAt") }.thenBy { it.getString("id") }).map {
        val id = it.getString("id")
        ComposerRun(id, it.optString("generation"), it.getString("status"), id in tools, id in reasoning, id in replies)
    }
}

internal val MobileUiState.composerSource: ComposerRun? get() {
    if (!connected || !conversationReady || readingCached || viewingArchived || screen != MobileScreen.Conversation) return null
    val approvals = approvalItems.filter { it.optString("status") == "pending" }.map { it.optString("runId") }.toSet()
    val answers = if (questionsSupported) questions.filter { it.optString("status") == "pending" }.map { it.optString("runId") }.toSet() else emptySet()
    val source = composerSources.firstOrNull { it.id in approvals || it.id in answers }
        ?: composerSources.firstOrNull { it.id == stoppingRunId }
        ?: composerSources.firstOrNull { it.status == "running" } ?: composerSources.firstOrNull() ?: return null
    return source.copy(awaitingApproval = source.id in approvals, awaitingAnswer = source.id in answers, stopping = source.id == stoppingRunId)
}

@Composable
internal fun ComposerPhase(state: MobileUiState) {
    val activity = state.composerActivity?.takeIf { it.topic == state.readerTopic && it.source == state.composerSource } ?: return
    val colors = MaterialTheme.colorScheme
    Surface(
        modifier = Modifier.padding(bottom = 8.dp).testTag("composerPhase").semantics { liveRegion = LiveRegionMode.Polite },
        shape = RoundedCornerShape(6.dp),
        color = if (activity.warning) colors.tertiaryContainer else colors.surfaceContainerHigh,
        contentColor = if (activity.warning) colors.onTertiaryContainer else colors.onSurface,
        border = BorderStroke(1.dp, colors.outlineVariant),
    ) {
        Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (activity.active) CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp, color = if (activity.warning) colors.tertiary else colors.primary)
            Text(activity.label, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}
