package app.uselexora.mobile.watch

import android.app.Notification
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import app.uselexora.mobile.ui.MainActivity
import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.notifications.MobileNotifier
import app.uselexora.mobile.notifications.NotificationSettings

class MobileWatchService : Service() {
    private var runtime: WatchRuntime? = null
    private var started = false

    override fun onCreate() {
        super.onCreate()
        runtime = WatchRuntime.shared(this)
        WatchRuntime.display.onChanged = ::update
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (!NotificationSettings(this).read().watchEnabled) {
            stopSelf()
            return START_NOT_STICKY
        }
        MobileNotifier(this).ensureChannels()
        val runtime = runtime ?: return START_NOT_STICKY
        enterForeground(notification(WatchRuntime.display.status))
        started = true
        val connect = intent == null || intent.getBooleanExtra(EXTRA_CONNECT, true)
        if (connect) runtime.resume() else runtime.pause()
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        started = false
        WatchRuntime.display.onChanged = null
        WatchRuntime.existing()?.pause()
        super.onDestroy()
    }

    private fun enterForeground(value: Notification) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
            startForeground(WATCH_ID, value, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        else
            startForeground(WATCH_ID, value)
    }

    private fun update(status: WatchStatus) {
        if (!started) return
        runCatching { NotificationManagerCompat.from(this).notify(WATCH_ID, notification(status)) }
    }

    private fun notification(status: WatchStatus): Notification {
        val open = PendingIntent.getActivity(this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        return NotificationCompat.Builder(this, MobileNotifier.CHANNEL_WATCH)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(mobileText(R.string.notification_watch_title))
            .setContentText(status.text())
            .setOnlyAlertOnce(true)
            .setOngoing(true)
            .setShowWhen(false)
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(open)
            .build()
    }

    companion object {
        private const val WATCH_ID = 0x2A01
        private const val EXTRA_CONNECT = "app.uselexora.mobile.extra.watch.connect"

        fun ensureRunning(context: Context, connect: Boolean) {
            if (!NotificationSettings(context).read().watchEnabled) return
            val intent = Intent(context, MobileWatchService::class.java).putExtra(EXTRA_CONNECT, connect)
            try {
                ContextCompat.startForegroundService(context, intent)
            } catch (_: Exception) {
            }
        }

        fun start(context: Context) = ensureRunning(context, connect = true)

        fun suspendForUi(context: Context) {
            runCatching { context.stopService(Intent(context, MobileWatchService::class.java)) }
            WatchRuntime.existing()?.pause()
        }
    }
}
