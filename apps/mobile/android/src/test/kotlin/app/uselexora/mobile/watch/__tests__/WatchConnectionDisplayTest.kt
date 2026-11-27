package app.uselexora.mobile.watch

import app.uselexora.mobile.session.MobileConnectionPhase
import org.junit.Assert.assertEquals
import org.junit.Test

class WatchConnectionDisplayTest {
    @Test fun handoffAndReconnectDoNotReuseThePreviousOwnersName() {
        val display = WatchConnectionDisplay()
        val first = WatchStatus.Connected("Studio")
        val second = WatchStatus.Connected("Office")
        val retrying = WatchStatus.Offline(MobileConnectionPhase.Retrying)
        display.reportForeground(first)
        display.useBackground(true)
        assertEquals(WatchStatus.Offline(), display.status)
        display.reportBackground(first)
        display.reportForeground(WatchStatus.Offline())
        assertEquals(first, display.status)
        display.reportBackground(retrying)
        assertEquals(retrying, display.status)
        display.useBackground(false)
        assertEquals(WatchStatus.Offline(), display.status)
        display.reportForeground(second)
        display.reportBackground(first)
        assertEquals(second, display.status)
    }

    @Test fun renamesUpdateTheNotificationWithoutRepeatingUnchangedStates() {
        val display = WatchConnectionDisplay()
        val history = mutableListOf<WatchStatus>()
        display.onChanged = { history.add(it) }
        val initial = WatchStatus.Connected("Studio")
        val renamed = WatchStatus.Connected("Home")
        display.reportForeground(initial)
        display.reportForeground(initial)
        display.reportForeground(renamed)
        display.reportForeground(WatchStatus.Offline())
        assertEquals(listOf(initial, renamed, WatchStatus.Offline()), history)
    }
}
