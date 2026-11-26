package app.uselexora.mobile.notifications

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class NotificationPolicyTest {
    @Test fun normalizesOnlyStrictLocalTimes() {
        assertEquals("07:05", NotificationPolicy.normalizeTime(" 07:05 "))
        assertNull(NotificationPolicy.normalizeTime("7:05"))
        assertNull(NotificationPolicy.normalizeTime("24:00"))
        assertNull(NotificationPolicy.normalizeTime(""))
        assertNull(NotificationPolicy.normalizeTime(null))
    }

    @Test fun quietWindowCrossingMidnightCoversBothEnds() {
        val preferences = NotificationPreferences(quietHoursEnabled = true, quietStart = "22:00", quietEnd = "07:00")
        assertTrue(NotificationPolicy.isQuiet(preferences, 22 * 60))
        assertTrue(NotificationPolicy.isQuiet(preferences, 23 * 60 + 59))
        assertTrue(NotificationPolicy.isQuiet(preferences, 0))
        assertTrue(NotificationPolicy.isQuiet(preferences, 6 * 60 + 59))
        assertFalse(NotificationPolicy.isQuiet(preferences, 7 * 60))
        assertFalse(NotificationPolicy.isQuiet(preferences, 12 * 60))
    }

    @Test fun quietWindowInsideOneDayUsesHalfOpenRange() {
        val preferences = NotificationPreferences(quietHoursEnabled = true, quietStart = "09:00", quietEnd = "17:00")
        assertTrue(NotificationPolicy.isQuiet(preferences, 9 * 60))
        assertFalse(NotificationPolicy.isQuiet(preferences, 17 * 60))
        assertFalse(NotificationPolicy.isQuiet(preferences, 8 * 60 + 59))
    }

    @Test fun disabledOrEqualBoundsAreHandledWithoutGuessing() {
        assertFalse(NotificationPolicy.isQuiet(NotificationPreferences(quietHoursEnabled = false), 23 * 60))
        assertTrue(NotificationPolicy.isQuiet(NotificationPreferences(quietHoursEnabled = true, quietStart = "22:00", quietEnd = "22:00"), 3 * 60))
        assertFalse(NotificationPolicy.isQuiet(NotificationPreferences(quietHoursEnabled = true, quietStart = "bad", quietEnd = "07:00"), 23 * 60))
    }

    @Test fun minuteOfDayFollowsTheZone() {
        val midnight = java.time.Instant.parse("2026-01-01T00:00:00Z").toEpochMilli()
        assertEquals(0, NotificationPolicy.minutesOfDay(midnight, java.time.ZoneId.of("UTC")))
        assertEquals(8 * 60, NotificationPolicy.minutesOfDay(midnight, java.time.ZoneId.of("Asia/Shanghai")))
    }
}
