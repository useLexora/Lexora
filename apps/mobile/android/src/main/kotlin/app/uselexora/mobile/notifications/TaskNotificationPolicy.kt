package app.uselexora.mobile.notifications

import org.json.JSONObject

internal enum class TaskNotificationKind(val tag: String) {
    Approval("approval"),
    Question("question"),
    Result("result"),
}

internal data class TaskNotificationState(
    val conversationId: String,
    val title: String?,
    val activity: String,
    val unread: Boolean,
    val lastRunStatus: String?,
    val resultRunId: String?,
    val resultBranchId: String?,
    val pendingQuestionCount: Int,
    val preview: String?,
    val lastActivityAt: Long?,
) {
    val awaitingApproval: Boolean get() = activity == "awaiting_approval"
    val awaitsAnswer: Boolean get() = pendingQuestionCount > 0
    val finished: Boolean get() = lastRunStatus == "completed" || lastRunStatus == "failed"
    val failed: Boolean get() = lastRunStatus == "failed"

    companion object {
        fun from(item: JSONObject): TaskNotificationState? {
            val conversationId = item.optString("id")
            if (conversationId.isEmpty() || conversationId == "null") return null
            return TaskNotificationState(
                conversationId = conversationId,
                title = item.optString("title").takeUnless { it.isEmpty() || it == "null" },
                activity = item.optString("activity"),
                unread = item.optBoolean("unread"),
                lastRunStatus = item.optString("lastRunStatus").takeUnless { it.isEmpty() || it == "null" },
                resultRunId = item.optString("resultRunId").takeUnless { it.isEmpty() || it == "null" },
                resultBranchId = item.optString("resultBranchId").takeUnless { it.isEmpty() || it == "null" },
                pendingQuestionCount = item.optInt("pendingQuestionCount"),
                preview = item.optString("previewText").takeUnless { it.isEmpty() || it == "null" },
                lastActivityAt = runCatching { java.time.Instant.parse(item.getString("lastActivityAt")).toEpochMilli() }.getOrNull(),
            )
        }
    }
}

internal sealed interface TaskNotificationEvent {
    val conversationId: String
    val kind: TaskNotificationKind

    data class Show(
        override val conversationId: String,
        override val kind: TaskNotificationKind,
        val title: String?,
        val preview: String?,
        val branchId: String?,
        val runId: String?,
        val failed: Boolean,
    ) : TaskNotificationEvent

    data class Retract(override val conversationId: String, override val kind: TaskNotificationKind) : TaskNotificationEvent
}

internal object TaskNotificationPolicy {
    const val RECENT_RESULT_WINDOW_MS = 10 * 60 * 1000L

    fun runKey(conversationId: String, runId: String): String = "$conversationId\u0000$runId"

    fun evaluate(
        previous: List<TaskNotificationState>?,
        current: List<TaskNotificationState>,
        preferences: NotificationPreferences,
        quiet: Boolean,
        nowMillis: Long,
        muted: Set<String>,
        notifiedRuns: Set<String>,
    ): List<TaskNotificationEvent> {
        val earlier = previous?.associateBy { it.conversationId }
        val events = mutableListOf<TaskNotificationEvent>()

        for (state in current) {
            val before = earlier?.get(state.conversationId)
            val first = before == null
            fun announce(): Boolean = !quiet && (!first || recent(state, nowMillis))

            val approval = wantsApproval(state, preferences, muted)
            val approvalBefore = before != null && wantsApproval(before, preferences, muted)
            if (approval && !approvalBefore && announce())
                events += TaskNotificationEvent.Show(state.conversationId, TaskNotificationKind.Approval, state.title, state.preview,
                    state.resultBranchId, null, false)
            if (approvalBefore && !approval) events += TaskNotificationEvent.Retract(state.conversationId, TaskNotificationKind.Approval)

            val question = wantsAnswer(state, preferences, muted)
            val questionBefore = before != null && wantsAnswer(before, preferences, muted)
            if (question && !questionBefore && announce())
                events += TaskNotificationEvent.Show(state.conversationId, TaskNotificationKind.Question, state.title, state.preview,
                    state.resultBranchId, null, false)
            if (questionBefore && !question) events += TaskNotificationEvent.Retract(state.conversationId, TaskNotificationKind.Question)

            val result = wantsResult(state, preferences, muted, notifiedRuns)
            val resultBefore = before != null && wantsResult(before, preferences, muted, notifiedRuns)
            if (result && !resultBefore && announce())
                events += TaskNotificationEvent.Show(state.conversationId, TaskNotificationKind.Result, state.title, state.preview,
                    state.resultBranchId, state.resultRunId, state.failed)
            if (resultBefore && !result) events += TaskNotificationEvent.Retract(state.conversationId, TaskNotificationKind.Result)
        }

        earlier?.forEach { (conversationId, before) ->
            if (current.any { it.conversationId == conversationId }) return@forEach
            if (before.awaitingApproval) events += TaskNotificationEvent.Retract(conversationId, TaskNotificationKind.Approval)
            if (before.awaitsAnswer) events += TaskNotificationEvent.Retract(conversationId, TaskNotificationKind.Question)
            if (before.unread && before.resultRunId != null) events += TaskNotificationEvent.Retract(conversationId, TaskNotificationKind.Result)
        }
        return events
    }

    private fun recent(state: TaskNotificationState, nowMillis: Long): Boolean {
        val at = state.lastActivityAt ?: return false
        return nowMillis - at in 0..RECENT_RESULT_WINDOW_MS
    }

    private fun wantsApproval(state: TaskNotificationState, preferences: NotificationPreferences, muted: Set<String>): Boolean =
        preferences.approvals && state.conversationId !in muted && state.awaitingApproval

    private fun wantsAnswer(state: TaskNotificationState, preferences: NotificationPreferences, muted: Set<String>): Boolean =
        preferences.questions && state.conversationId !in muted && state.awaitsAnswer

    private fun wantsResult(state: TaskNotificationState, preferences: NotificationPreferences, muted: Set<String>, notifiedRuns: Set<String>): Boolean {
        val enabled = if (state.failed) preferences.failed else preferences.completed
        if (!enabled || state.conversationId in muted) return false
        if (!state.unread || !state.finished) return false
        val run = state.resultRunId ?: return false
        return runKey(state.conversationId, run) !in notifiedRuns
    }
}
