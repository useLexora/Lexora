package app.uselexora.mobile.protocol

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import org.json.JSONObject

data class ExecutionMode(private val labelResource: Int, val profile: String, val policy: String, private val descriptionResource: Int) {
    val label get() = mobileText(labelResource)
    val description get() = mobileText(descriptionResource)
    fun config() = JSONObject().put("executionProfile", profile).put("approvalPolicy", policy)
    fun matches(config: JSONObject) = config.optString("executionProfile") == profile && config.optString("approvalPolicy") == policy
}

object ExecutionSettings {
    val modes = listOf(
        ExecutionMode(R.string.label_read_only, "read_only", "policy", R.string.label_read_and_inspect_without_modifying_files),
        ExecutionMode(R.string.label_ask_for_approval, "workspace_write", "manual", R.string.label_ask_before_writing_files_executing_commands_or_accessing_the_network),
        ExecutionMode(R.string.label_smart_approval, "workspace_write", "policy", R.string.label_work_within_granted_permissions_and_ask_when_more_access_is_needed),
        ExecutionMode(R.string.label_full_access, "full_access", "policy", R.string.label_use_the_host_account_s_permissions_and_approve_actions_automatically)
    )
    fun defaultConfig() = modes[2].config()
    fun resolve(draft: JSONObject?, task: JSONObject?): JSONObject {
        draft?.optJSONObject("executionConfig")?.let { return JSONObject(it.toString()) }
        if (task != null && task.has("executionProfile") && task.has("approvalPolicy")) {
            return JSONObject().put("executionProfile", task.getString("executionProfile")).put("approvalPolicy", task.getString("approvalPolicy"))
        }
        return defaultConfig()
    }
    fun label(config: JSONObject) = modes.firstOrNull { it.matches(config) }?.label ?: mobileText(R.string.execution_inherited)
}
