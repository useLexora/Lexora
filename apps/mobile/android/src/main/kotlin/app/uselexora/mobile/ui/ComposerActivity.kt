package app.uselexora.mobile.ui

import android.animation.ValueAnimator
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.Crossfade
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutLinearInEasing
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.time.Instant
import kotlin.math.roundToInt
import kotlinx.coroutines.delay
import org.json.JSONObject

data class ComposerRun(
    val id: String, val generation: String, val status: String,
    val runningTool: Boolean, val runningReasoning: Boolean, val replying: Boolean,
    val awaitingApproval: Boolean = false, val awaitingAnswer: Boolean = false, val stopping: Boolean = false,
    val startedAt: Long? = null,
) {
    internal fun wire(request: Long): JSONObject = JSONObject().put("requestId", request.toString()).put("runId", id).put("status", status)
        .put("runningTool", runningTool).put("runningReasoning", runningReasoning).put("replying", replying)
        .put("awaitingApproval", awaitingApproval).put("awaitingAnswer", awaitingAnswer).put("stopping", stopping)
}

data class ComposerActivity(val topic: String, val source: ComposerRun, val label: String, val active: Boolean, val warning: Boolean)

internal fun startedAtMillis(value: Any?): Long? = when (value) {
    is Number -> value.toLong()
    is String -> runCatching { Instant.parse(value).toEpochMilli() }.getOrNull()
    else -> null
}

internal fun formatActivityElapsed(startedAt: Long, now: Long): String {
    val seconds = ((now - startedAt).coerceAtLeast(0L) / 1_000.0).roundToInt().coerceAtLeast(1)
    if (seconds < 60) return "${seconds}s"
    val minutes = seconds / 60
    val remainder = seconds % 60
    return if (remainder == 0) "${minutes}m" else "${minutes}m ${remainder}s"
}

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
        ComposerRun(id, it.optString("generation"), it.getString("status"), id in tools, id in reasoning, id in replies,
            startedAt = startedAtMillis(it.opt("startedAt")))
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

internal val MobileUiState.composerPhaseActivity: ComposerActivity? get() {
    val activity = composerActivity ?: return null
    if (activity.topic != readerTopic || composerSource == null) return null
    return activity.takeIf { shown -> composerSources.any { it.id == shown.source.id } }
}

@Composable
internal fun ComposerPhase(state: MobileUiState) {
    val activity = state.composerPhaseActivity
    val shown = rememberShownActivity(activity)
    AnimatedVisibility(
        visible = activity != null,
        enter = fadeIn(tween(140)) + expandVertically(animationSpec = tween(170, easing = LinearOutSlowInEasing)),
        exit = fadeOut(tween(110)) + shrinkVertically(animationSpec = tween(150, easing = FastOutLinearInEasing)),
    ) {
        shown?.let { ComposerPhaseRow(it) }
    }
}

@Composable
private fun rememberShownActivity(activity: ComposerActivity?): ComposerActivity? {
    val shown = remember { mutableStateOf(activity) }
    if (activity != null && shown.value !== activity) shown.value = activity
    return shown.value
}

@Composable
private fun ComposerPhaseRow(activity: ComposerActivity) {
    val colors = MaterialTheme.colorScheme
    val observedAt = remember(activity.source.id) { System.currentTimeMillis() }
    val startedAt = activity.source.startedAt?.takeIf { it > 0L }?.coerceAtMost(observedAt)
    val now = rememberActivityNow(startedAt)
    val elapsed = startedAt?.let { formatActivityElapsed(it, now) }
    val tint by animateColorAsState(if (activity.warning) colors.tertiary else colors.onSurfaceVariant, tween(180), label = "composer-phase-tint")
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = 2.dp, end = 2.dp, bottom = 8.dp)
            .testTag("composerPhase")
            .semantics(mergeDescendants = true) { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(7.dp),
    ) {
        ComposerPhaseGlyph(active = activity.active, color = tint)
        Text(activity.label, style = MaterialTheme.typography.labelMedium, color = tint, maxLines = 1,
            overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (elapsed != null) {
            Text(elapsed, style = MaterialTheme.typography.labelMedium.copy(fontFeatureSettings = "tnum"), maxLines = 1,
                color = tint.copy(alpha = .72f), modifier = Modifier.clearAndSetSemantics {})
        }
    }
}

@Composable
private fun rememberActivityNow(startedAt: Long?): Long {
    var now by remember(startedAt) { mutableLongStateOf(startedAt?.let { System.currentTimeMillis() } ?: 0L) }
    LaunchedEffect(startedAt) {
        if (startedAt != null) while (true) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    return now
}

@Composable
private fun ComposerPhaseGlyph(active: Boolean, color: Color) {
    Crossfade(targetState = active, modifier = Modifier.size(15.dp), animationSpec = tween(180),
        label = "composer-phase-glyph") { running ->
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            if (running) AnimatedOrbitGlyph(color, Modifier.fillMaxSize())
            else Icon(Icons.Outlined.Schedule, null, Modifier.size(14.dp), tint = color)
        }
    }
}

@Composable
private fun AnimatedOrbitGlyph(color: Color, modifier: Modifier) {
    if (!ValueAnimator.areAnimatorsEnabled()) {
        OrbitGlyph(color, progress = .3f, glow = .6f, modifier = modifier)
        return
    }
    val transition = rememberInfiniteTransition(label = "composer-phase")
    val spin by transition.animateFloat(0f, 1f, infiniteRepeatable(tween(3_200, easing = LinearEasing)), label = "composer-phase-spin")
    val glow by transition.animateFloat(.3f, .85f, infiniteRepeatable(tween(1_500, easing = FastOutSlowInEasing), RepeatMode.Reverse), label = "composer-phase-glow")
    OrbitGlyph(color, progress = spin, glow = glow, modifier = modifier)
}

private class OrbitTrack(val tilt: Float, val squash: Float, val turns: Float, val phase: Float)

private val orbitTracks = listOf(
    OrbitTrack(tilt = -16f, squash = .40f, turns = 1f, phase = 0f),
    OrbitTrack(tilt = 62f, squash = .36f, turns = -1.35f, phase = 120f),
    OrbitTrack(tilt = 118f, squash = .44f, turns = 1.18f, phase = 240f),
)

@Composable
private fun OrbitGlyph(color: Color, progress: Float, glow: Float, modifier: Modifier) {
    Canvas(modifier) {
        val stroke = 1.dp.toPx()
        orbitTracks.forEach { track ->
            val radius = size.minDimension / 2f - stroke
            val start = progress * 360f * track.turns + track.phase
            rotate(degrees = track.tilt, pivot = center) {
                scale(scaleX = 1f, scaleY = track.squash, pivot = center) {
                    drawCircle(color.copy(alpha = .15f), radius = radius, center = center, style = Stroke(width = stroke))
                    drawArc(color.copy(alpha = .92f), startAngle = start, sweepAngle = 100f, useCenter = false,
                        style = Stroke(width = stroke, cap = StrokeCap.Round))
                }
            }
        }
        drawCircle(color.copy(alpha = glow * .16f), radius = 2.6.dp.toPx() / 2)
        drawCircle(color.copy(alpha = glow), radius = 1.3.dp.toPx() / 2)
    }
}
