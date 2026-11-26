package app.uselexora.mobile.notifications

import android.content.Context

internal data class NotificationSettingsSnapshot(
    val watchEnabled: Boolean = true,
    val approvals: Boolean = true,
    val questions: Boolean = true,
    val completed: Boolean = true,
    val failed: Boolean = true,
    val quietHoursEnabled: Boolean = false,
    val quietStart: String = "22:00",
    val quietEnd: String = "07:00",
    val showTitle: Boolean = true,
    val showPreview: Boolean = false,
) {
    fun preferences(): NotificationPreferences = NotificationPreferences(approvals, questions, completed, failed,
        quietHoursEnabled, quietStart, quietEnd)
}

internal class NotificationSettings(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("notifications", Context.MODE_PRIVATE)

    fun read(): NotificationSettingsSnapshot = NotificationSettingsSnapshot(
        watchEnabled = prefs.getBoolean(KEY_WATCH, true),
        approvals = prefs.getBoolean(KEY_APPROVALS, true),
        questions = prefs.getBoolean(KEY_QUESTIONS, true),
        completed = prefs.getBoolean(KEY_COMPLETED, true),
        failed = prefs.getBoolean(KEY_FAILED, true),
        quietHoursEnabled = prefs.getBoolean(KEY_QUIET_ENABLED, false),
        quietStart = NotificationPolicy.normalizeTime(prefs.getString(KEY_QUIET_START, null)) ?: "22:00",
        quietEnd = NotificationPolicy.normalizeTime(prefs.getString(KEY_QUIET_END, null)) ?: "07:00",
        showTitle = prefs.getBoolean(KEY_SHOW_TITLE, true),
        showPreview = prefs.getBoolean(KEY_SHOW_PREVIEW, false),
    )

    fun setWatchEnabled(value: Boolean) = prefs.edit().putBoolean(KEY_WATCH, value).apply()
    fun setApprovals(value: Boolean) = prefs.edit().putBoolean(KEY_APPROVALS, value).apply()
    fun setQuestions(value: Boolean) = prefs.edit().putBoolean(KEY_QUESTIONS, value).apply()
    fun setCompleted(value: Boolean) = prefs.edit().putBoolean(KEY_COMPLETED, value).apply()
    fun setFailed(value: Boolean) = prefs.edit().putBoolean(KEY_FAILED, value).apply()
    fun setQuietHoursEnabled(value: Boolean) = prefs.edit().putBoolean(KEY_QUIET_ENABLED, value).apply()
    fun setShowTitle(value: Boolean) = prefs.edit().putBoolean(KEY_SHOW_TITLE, value).apply()
    fun setShowPreview(value: Boolean) = prefs.edit().putBoolean(KEY_SHOW_PREVIEW, value).apply()

    fun setQuietStart(value: String) {
        val normalized = NotificationPolicy.normalizeTime(value) ?: return
        prefs.edit().putString(KEY_QUIET_START, normalized).apply()
    }

    fun setQuietEnd(value: String) {
        val normalized = NotificationPolicy.normalizeTime(value) ?: return
        prefs.edit().putString(KEY_QUIET_END, normalized).apply()
    }

    fun isMuted(partition: String, conversationId: String): Boolean = prefs.getStringSet(KEY_MUTED, emptySet()).orEmpty().contains(taskKey(partition, conversationId))

    fun setMuted(partition: String, conversationId: String, muted: Boolean) {
        val keys = prefs.getStringSet(KEY_MUTED, emptySet()).orEmpty().toMutableSet()
        val key = taskKey(partition, conversationId)
        if (muted) {
            if (keys.size >= MUTE_LIMIT && key !in keys) return
            keys.add(key)
        } else {
            keys.remove(key)
        }
        prefs.edit().putStringSet(KEY_MUTED, keys).apply()
    }

    fun mutedConversationIds(partition: String): Set<String> {
        val prefix = taskPrefix(partition)
        return prefs.getStringSet(KEY_MUTED, emptySet()).orEmpty()
            .filter { it.startsWith(prefix) }
            .map { it.removePrefix(prefix) }
            .filter { it.isNotEmpty() }
            .toSet()
    }

    companion object {
        private const val KEY_WATCH = "watch"
        private const val KEY_APPROVALS = "approvals"
        private const val KEY_QUESTIONS = "questions"
        private const val KEY_COMPLETED = "completed"
        private const val KEY_FAILED = "failed"
        private const val KEY_QUIET_ENABLED = "quietEnabled"
        private const val KEY_QUIET_START = "quietStart"
        private const val KEY_QUIET_END = "quietEnd"
        private const val KEY_SHOW_TITLE = "showTitle"
        private const val KEY_SHOW_PREVIEW = "showPreview"
        private const val KEY_MUTED = "muted"
        private const val MUTE_LIMIT = 200

        internal fun taskPrefix(partition: String): String = partition.replace('\u0000', '/') + "|"
        internal fun taskKey(partition: String, conversationId: String): String = taskPrefix(partition) + conversationId
    }
}

internal class NotificationLedger(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences("notification-ledger", Context.MODE_PRIVATE)

    fun record(partition: String, conversationId: String, runId: String) {
        val value = entry(partition, conversationId, runId)
        val keys = stored().toMutableList()
        keys.remove(value)
        keys.add(value)
        prefs.edit().putString(KEY, keys.takeLast(LIMIT).joinToString(SEPARATOR)).commit()
    }

    fun notified(partition: String, states: List<TaskNotificationState>): Set<String> {
        val prefix = NotificationSettings.taskPrefix(partition)
        val known = stored().filter { it.startsWith(prefix) }.toSet()
        return states.mapNotNull { state ->
            val run = state.resultRunId ?: return@mapNotNull null
            TaskNotificationPolicy.runKey(state.conversationId, run).takeIf { "$prefix${state.conversationId}\u0000$run" in known }
        }.toSet()
    }

    private fun stored(): Set<String> = prefs.getString(KEY, "").orEmpty().split(SEPARATOR).filterTo(mutableSetOf()) { it.isNotEmpty() }

    private fun entry(partition: String, conversationId: String, runId: String): String =
        "${NotificationSettings.taskPrefix(partition)}$conversationId\u0000$runId"

    companion object {
        private const val KEY = "runs"
        private const val SEPARATOR = "\n"
        private const val LIMIT = 400
    }
}
