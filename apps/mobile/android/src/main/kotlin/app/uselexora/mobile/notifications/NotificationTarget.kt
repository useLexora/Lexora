package app.uselexora.mobile.notifications

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import app.uselexora.mobile.MainActivity
import org.json.JSONObject

internal object NotificationTarget {
    const val ACTION = "app.uselexora.mobile.action.OPEN_NOTIFICATION"
    private const val EXTRA_PARTITION = "app.uselexora.mobile.extra.notification.partition"
    private const val EXTRA_CONVERSATION = "app.uselexora.mobile.extra.notification.conversation"
    private const val EXTRA_BRANCH = "app.uselexora.mobile.extra.notification.branch"
    private const val EXTRA_KIND = "app.uselexora.mobile.extra.notification.kind"

    fun pending(context: Context, partition: String, event: TaskNotificationEvent.Show): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(ACTION)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_PARTITION, partition)
            .putExtra(EXTRA_CONVERSATION, event.conversationId)
            .putExtra(EXTRA_BRANCH, event.branchId ?: "")
            .putExtra(EXTRA_KIND, event.kind.name)
        val code = (event.conversationId + ':' + event.kind.name).hashCode()
        return PendingIntent.getActivity(context, code, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun read(intent: Intent?): JSONObject? {
        if (intent == null || intent.action != ACTION) return null
        val conversationId = intent.getStringExtra(EXTRA_CONVERSATION).orEmpty()
        if (conversationId.isEmpty()) return null
        return JSONObject()
            .put("partition", intent.getStringExtra(EXTRA_PARTITION).orEmpty())
            .put("conversationId", conversationId)
            .put("branchId", intent.getStringExtra(EXTRA_BRANCH).orEmpty())
            .put("kind", intent.getStringExtra(EXTRA_KIND).orEmpty())
    }
}
