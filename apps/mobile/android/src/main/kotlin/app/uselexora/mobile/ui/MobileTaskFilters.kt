package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import org.json.JSONObject

internal fun taskFilterTitle(filter: MobileTaskFilter): String = when (filter) {
    MobileTaskFilter.All -> mobileText(R.string.label_all_tasks)
    MobileTaskFilter.Approvals -> mobileText(R.string.label_tasks_awaiting_approval)
    MobileTaskFilter.Questions -> mobileText(R.string.label_tasks_awaiting_answers)
    MobileTaskFilter.Unread -> mobileText(R.string.label_unread_tasks)
    MobileTaskFilter.Marked -> mobileText(R.string.label_marked)
}

internal fun matchesTaskFilter(task: JSONObject, filter: MobileTaskFilter, markedTaskIds: Set<String>): Boolean = when (filter) {
    MobileTaskFilter.All -> true
    MobileTaskFilter.Approvals -> task.optString("activity") == "awaiting_approval"
    MobileTaskFilter.Questions -> task.optInt("pendingQuestionCount") > 0
    MobileTaskFilter.Unread -> task.optBoolean("unread")
    MobileTaskFilter.Marked -> task.optString("id") in markedTaskIds
}

internal fun taskFilterCount(tasks: List<JSONObject>, filter: MobileTaskFilter, loaded: Boolean, markedTaskIds: Set<String>, marksLoaded: Boolean): Int? {
    if (!loaded) return null
    val field = when (filter) {
        MobileTaskFilter.Approvals -> "activity"
        MobileTaskFilter.Questions -> "pendingQuestionCount"
        MobileTaskFilter.Unread -> "unread"
        else -> null
    }
    if (field != null && tasks.any { !it.has(field) || it.isNull(field) }) return null
    if (filter == MobileTaskFilter.Marked && !marksLoaded) return null
    return tasks.count { matchesTaskFilter(it, filter, markedTaskIds) }
}
