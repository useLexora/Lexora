package app.uselexora.mobile

import android.app.Activity
import android.app.Application
import android.content.Context
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import app.uselexora.mobile.i18n.MobileStrings
import app.uselexora.mobile.notifications.NotificationSettings
import app.uselexora.mobile.protocol.ProtocolSchemas
import app.uselexora.mobile.ui.MobileAppearance
import app.uselexora.mobile.watch.MobileWatchService
import app.uselexora.mobile.watch.WatchRuntime
import org.json.JSONObject

class MobileApplication : Application() {
    private val handler = Handler(Looper.getMainLooper())
    private var startedActivities = 0
    private val resumeWatch = Runnable {
        if (!NotificationSettings(this).read().watchEnabled) {
            MobileWatchService.suspendForUi(this)
            return@Runnable
        }
        MobileWatchService.ensureRunning(this, connect = true)
    }

    override fun onCreate() {
        super.onCreate()
        MobileStrings.initialize(this)
        if (android.os.Process.myUid() == applicationInfo.uid) {
            MobileAppearance.load(this)
            registerActivityLifecycleCallbacks(Foreground())
        }
    }

    private inner class Foreground : Application.ActivityLifecycleCallbacks {
        override fun onActivityStarted(activity: Activity) {
            handler.removeCallbacks(resumeWatch)
            startedActivities++
            if (startedActivities != 1) return
            WatchRuntime.existing()?.pause()
            MobileWatchService.ensureRunning(this@MobileApplication, connect = false)
        }

        override fun onActivityStopped(activity: Activity) {
            startedActivities = (startedActivities - 1).coerceAtLeast(0)
            if (startedActivities != 0) return
            handler.removeCallbacks(resumeWatch)
            handler.postDelayed(resumeWatch, WATCH_HANDOFF_DELAY_MS)
        }

        override fun onActivityCreated(activity: Activity, state: Bundle?) {}
        override fun onActivityResumed(activity: Activity) {}
        override fun onActivityPaused(activity: Activity) {}
        override fun onActivitySaveInstanceState(activity: Activity, state: Bundle) {}
        override fun onActivityDestroyed(activity: Activity) {}
    }

    companion object {
        private const val WATCH_HANDOFF_DELAY_MS = 400L
        @Volatile private var cached: ProtocolSchemas? = null

        fun schemas(context: Context): ProtocolSchemas = cached ?: synchronized(this) {
            cached ?: ProtocolSchemas(JSONObject(context.applicationContext.assets.open("protocol-schema.json")
                .bufferedReader().use { it.readText() })).also { cached = it }
        }
    }
}
