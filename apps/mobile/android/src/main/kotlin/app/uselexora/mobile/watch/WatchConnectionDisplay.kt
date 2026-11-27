package app.uselexora.mobile.watch

import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.session.MobileConnectionPhase

internal sealed interface WatchStatus {
    data class Connected(val serviceName: String?) : WatchStatus
    data class Offline(val phase: MobileConnectionPhase = MobileConnectionPhase.Idle) : WatchStatus

    fun text(): String = when (this) {
        is Connected -> if (serviceName.isNullOrBlank()) mobileText(R.string.connection_connected)
            else mobileText(R.string.notification_watch_connected, serviceName)
        is Offline -> mobileText(when (phase) {
            MobileConnectionPhase.Idle -> R.string.notification_watch_paused
            MobileConnectionPhase.Connecting -> R.string.notification_watch_connecting
            MobileConnectionPhase.Retrying -> R.string.notification_watch_retrying
            MobileConnectionPhase.Unavailable -> R.string.notification_watch_unreachable
        })
    }
}

internal class WatchConnectionDisplay {
    private var foreground: WatchStatus = WatchStatus.Offline()
    var status: WatchStatus = foreground
        private set
    @Volatile var watching = false
        private set
    var onChanged: ((WatchStatus) -> Unit)? = null

    fun useBackground(enabled: Boolean) {
        if (watching == enabled) return
        watching = enabled
        publish(if (enabled) WatchStatus.Offline() else foreground)
    }

    fun reportForeground(value: WatchStatus) {
        foreground = value
        if (!watching) publish(value)
    }

    fun reportBackground(value: WatchStatus) {
        if (watching) publish(value)
    }

    private fun publish(value: WatchStatus) {
        if (value == status) return
        status = value
        onChanged?.invoke(value)
    }
}
