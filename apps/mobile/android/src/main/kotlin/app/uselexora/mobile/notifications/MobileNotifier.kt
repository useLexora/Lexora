package app.uselexora.mobile.notifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText

internal class MobileNotifier(private val context: Context) {
    private val manager = NotificationManagerCompat.from(context)

    fun ensureChannels() {
        val system = context.getSystemService(NotificationManager::class.java) ?: return
        system.createNotificationChannel(NotificationChannel(CHANNEL_WATCH, mobileText(R.string.notification_channel_watch), NotificationManager.IMPORTANCE_LOW).apply {
            description = mobileText(R.string.notification_channel_watch_description)
            setShowBadge(false)
            enableVibration(false)
            setSound(null, null)
        })
        system.createNotificationChannel(NotificationChannel(CHANNEL_ACTION, mobileText(R.string.notification_channel_action), NotificationManager.IMPORTANCE_HIGH).apply {
            description = mobileText(R.string.notification_channel_action_description)
        })
        system.createNotificationChannel(NotificationChannel(CHANNEL_RESULT, mobileText(R.string.notification_channel_result), NotificationManager.IMPORTANCE_DEFAULT).apply {
            description = mobileText(R.string.notification_channel_result_description)
        })
    }

    fun canNotify(): Boolean = manager.areNotificationsEnabled()

    fun show(partition: String, event: TaskNotificationEvent.Show, settings: NotificationSettingsSnapshot) {
        if (!canNotify()) return
        val channel = if (event.kind == TaskNotificationKind.Result) CHANNEL_RESULT else CHANNEL_ACTION
        val title = if (settings.showTitle) event.title ?: mobileText(R.string.notification_untitled) else mobileText(R.string.notification_generic_title)
        val label = when (event.kind) {
            TaskNotificationKind.Approval -> mobileText(R.string.notification_kind_approval)
            TaskNotificationKind.Question -> mobileText(R.string.notification_kind_question)
            TaskNotificationKind.Result -> if (event.failed) mobileText(R.string.notification_kind_failed) else mobileText(R.string.notification_kind_completed)
        }
        val body = if (event.kind == TaskNotificationKind.Result && settings.showPreview && !event.preview.isNullOrBlank()) "$label\n${event.preview}" else label
        val publicVersion = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(mobileText(R.string.notification_generic_title))
            .setContentText(label)
            .build()
        val notification = NotificationCompat.Builder(context, channel)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(if (event.kind == TaskNotificationKind.Result) NotificationCompat.CATEGORY_STATUS else NotificationCompat.CATEGORY_MESSAGE)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(publicVersion)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setShowWhen(true)
            .setWhen(System.currentTimeMillis())
            .setGroup(GROUP)
            .setContentIntent(NotificationTarget.pending(context, partition, event))
            .build()
        manager.notify(tag(event.conversationId, event.kind), id(event.conversationId, event.kind), notification)
    }

    fun retract(conversationId: String, kind: TaskNotificationKind) {
        manager.cancel(tag(conversationId, kind), id(conversationId, kind))
    }

    fun clearConversation(conversationId: String) {
        TaskNotificationKind.entries.forEach { retract(conversationId, it) }
    }

    fun clearKinds(kinds: Set<TaskNotificationKind>) {
        if (kinds.isEmpty()) return
        runCatching {
            manager.activeNotifications.forEach { active ->
                val tag = active.tag ?: return@forEach
                if (!tag.startsWith(TAG_PREFIX)) return@forEach
                val kind = TaskNotificationKind.entries.firstOrNull { tag.endsWith(":" + it.tag) } ?: return@forEach
                if (kind in kinds) manager.cancel(tag, active.id)
            }
        }
    }

    fun clearAll() {
        runCatching {
            manager.activeNotifications.forEach { active ->
                val tag = active.tag ?: return@forEach
                if (tag.startsWith(TAG_PREFIX)) manager.cancel(tag, active.id)
            }
        }
    }

    fun presentCount(): Int = runCatching { manager.activeNotifications.count { it.tag?.startsWith(TAG_PREFIX) == true } }.getOrDefault(0)

    private fun tag(conversationId: String, kind: TaskNotificationKind) = "$TAG_PREFIX$conversationId:${kind.tag}"

    private fun id(conversationId: String, kind: TaskNotificationKind) = tag(conversationId, kind).hashCode()

    companion object {
        const val CHANNEL_WATCH = "lexora-watch"
        const val CHANNEL_ACTION = "lexora-action"
        const val CHANNEL_RESULT = "lexora-result"
        private const val GROUP = "lexora-tasks"
        private const val TAG_PREFIX = "lexora-task:"
    }
}
