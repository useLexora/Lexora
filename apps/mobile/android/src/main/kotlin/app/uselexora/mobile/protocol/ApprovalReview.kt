package app.uselexora.mobile.protocol

import app.uselexora.mobile.i18n.MobileStrings
import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import org.json.JSONObject
import java.time.Instant

object ApprovalReview {
    private val fields = linkedMapOf("kind" to R.string.review_operation_type, "toolName" to R.string.review_tool, "arguments" to R.string.review_arguments, "cwd" to R.string.review_working_directory, "paths" to R.string.review_file_access, "browser" to R.string.review_browser_target, "automation" to R.string.mobile_automation_configuration, "shell" to R.string.review_command_environment, "systemAction" to R.string.review_system_action, "network" to R.string.review_network_target, "networkPermission" to R.string.mobile_network_permission, "sandboxDirectory" to R.string.review_directory_access_for_this_operation, "persistentDirectory" to R.string.review_persistent_directory_permission)
    private val kinds = mapOf("read" to R.string.review_read, "render" to R.string.review_render, "write" to R.string.review_write, "delete" to R.string.review_delete, "shell" to R.string.review_execute_command, "system" to R.string.review_system_interaction, "network" to R.string.review_network_access, "browser" to R.string.review_browser_interaction, "mcp" to R.string.review_mcp_call, "automation" to R.string.review_automation)
    private fun body(approval: JSONObject): JSONObject? = runCatching { JSONObject(approval.getJSONObject("review").getJSONObject("document").getString("text")) }.getOrNull()
    fun sections(approval: JSONObject, decision: JSONObject? = null): List<Pair<String, String>> {
        val review = approval.optJSONObject("review")
        val sections = mutableListOf(mobileText(R.string.review_status) to when (approval.optString("status")) { "pending" -> mobileText(R.string.review_awaiting_review); "approved" -> mobileText(R.string.review_allowed); "denied" -> mobileText(R.string.review_denied); else -> mobileText(R.string.review_cancelled_or_expired) }, mobileText(R.string.review_valid_until) to displayTime(review?.optString("expiresAt")))
        approval.optString("resolution").takeIf { it in labels }?.let { sections.add(mobileText(R.string.review_decision) to labels.getValue(it)) }
        if (!approval.isNull("resolvedAt")) sections.add(mobileText(R.string.review_decision_time) to displayTime(approval.getString("resolvedAt")))
        sections.addAll(decisionSections(approval, decision))
        val document = body(approval)
        if (document == null) sections.add(mobileText(R.string.review_review_details) to mobileText(R.string.review_complete_details_cannot_be_shown_review_on_desktop))
        else for (key in document.keys().asSequence().toList().sortedBy { fields.keys.indexOf(it).takeIf { position -> position >= 0 } ?: Int.MAX_VALUE }) {
            if (document.isNull(key)) continue
            val value = document.get(key)
            val text = when (value) { is JSONObject -> value.toString(2); is org.json.JSONArray -> value.toString(2); else -> value.toString() }
            sections.add((fields[key]?.let { mobileText(it) } ?: mobileText(R.string.mobile_unrecognized_field, key)) to if (key == "kind") kinds[text]?.let { mobileText(it) } ?: text else text)
        }
        if (review?.optBoolean("localManagementRequired") == true || review?.optBoolean("persistentEffect") == true) sections.add(mobileText(R.string.review_requires_desktop_review) to mobileText(R.string.review_this_operation_grants_persistent_access_and_requires_desktop_approval))
        else if (!complete(approval)) sections.add(mobileText(R.string.review_only_denial_is_available) to mobileText(R.string.review_complete_operation_details_are_unavailable_review_on_desktop))
        return sections
    }
    fun decisionSections(approval: JSONObject, decision: JSONObject?): List<Pair<String, String>> {
        if (decision == null || decision.optString("approvalId") != approval.optString("id") || decision.optString("reviewVersion") != approval.optJSONObject("review")?.optString("reviewVersion") || listOf("runId", "status", "resolution", "resolvedAt").any { decision.opt(it) != approval.opt(it) }) return emptyList()
        val actor = decision.optJSONObject("actor")
        val label = when {
            actor == null -> if (decision.isNull("cancellationReason")) mobileText(R.string.review_not_recorded) else mobileText(R.string.review_service)
            actor.optString("kind") == "desktop" -> mobileText(R.string.review_desktop)
            actor.optBoolean("current") -> mobileText(R.string.review_this_phone)
            else -> mobileText(R.string.review_another_device)
        }
        val sections = mutableListOf(mobileText(R.string.review_handled_by) to label)
        val reason = mapOf("cancelled" to mobileText(R.string.review_run_or_permission_cancelled), "expired" to mobileText(R.string.review_approval_expired), "recovery" to mobileText(R.string.review_invalidated_by_service_restart), "shutdown" to mobileText(R.string.review_service_stopped))[decision.optString("cancellationReason")]
        if (reason != null) sections.add(mobileText(R.string.review_cancellation_reason) to reason)
        return sections
    }
    private fun displayTime(value: String?): String = runCatching {
        java.text.DateFormat.getDateTimeInstance(java.text.DateFormat.SHORT, java.text.DateFormat.MEDIUM, MobileStrings.locale).format(java.util.Date.from(Instant.parse(value)))
    }.getOrDefault(mobileText(R.string.unknown))
    private fun complete(approval: JSONObject): Boolean {
        val review = approval.optJSONObject("review") ?: return false
        val document = review.optJSONObject("document")
        val body = body(approval) ?: return false
        return review.optBoolean("complete") && review.optInt("contentVersion") == 1 && !review.optBoolean("localManagementRequired") && !review.optBoolean("persistentEffect") && document?.optString("format") == "json" && approval.optString("kind") in supportedKinds && body.optString("kind") == approval.optString("kind") && body.opt("toolName") is String && body.has("arguments") && body.keys().asSequence().all { it in fields }
    }
    val supportedKinds = listOf("read", "render", "write", "delete", "shell", "system", "network", "browser", "mcp", "automation")
    private val decisionsLabels = linkedMapOf("approved" to R.string.review_once, "approved_for_operation" to R.string.review_operation, "approved_for_source" to R.string.review_source, "approved_for_turn" to R.string.review_turn, "denied" to R.string.review_deny)
    val labels get() = decisionsLabels.mapValues { mobileText(it.value) }
    fun decisions(approval: JSONObject, now: Instant): List<String> {
        val review = approval.optJSONObject("review") ?: return emptyList()
        if (approval.optString("status") != "pending" || runCatching { Instant.parse(review.getString("expiresAt")) > now }.getOrDefault(false).not()) return emptyList()
        val offered = review.optJSONArray("allowedDecisions") ?: return emptyList()
        val complete = complete(approval)
        return (0 until offered.length()).map { offered.getString(it) }.filter { it in decisionsLabels && (it == "denied" || complete) }
    }
}
