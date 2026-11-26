package app.uselexora.mobile.watch

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class WatchBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
        if (context == null) return
        when (intent?.action) {
            Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED -> MobileWatchService.start(context)
        }
    }
}
