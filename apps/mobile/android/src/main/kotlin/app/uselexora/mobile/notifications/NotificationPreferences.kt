package app.uselexora.mobile.notifications

internal data class NotificationPreferences(
    val approvals: Boolean = true,
    val questions: Boolean = true,
    val completed: Boolean = true,
    val failed: Boolean = true,
    val quietHoursEnabled: Boolean = false,
    val quietStart: String = "22:00",
    val quietEnd: String = "07:00",
)

internal object NotificationPolicy {
    private val localTime = Regex("""^([01]\d|2[0-3]):([0-5]\d)$""")

    fun normalizeTime(value: String?): String? = value?.trim()?.takeIf { localTime.matches(it) }

    fun minutesOfDay(value: String?): Int? = normalizeTime(value)?.let { it.substring(0, 2).toInt() * 60 + it.substring(3, 5).toInt() }

    fun minutesOfDay(nowMillis: Long, zone: java.time.ZoneId): Int = java.time.Instant.ofEpochMilli(nowMillis).atZone(zone).toLocalTime().let { it.hour * 60 + it.minute }

    fun isQuiet(preferences: NotificationPreferences, minuteOfDay: Int): Boolean {
        if (!preferences.quietHoursEnabled) return false
        val start = minutesOfDay(preferences.quietStart) ?: return false
        val end = minutesOfDay(preferences.quietEnd) ?: return false
        if (start == end) return true
        return if (start < end) minuteOfDay in start until end else minuteOfDay >= start || minuteOfDay < end
    }
}
