package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import org.json.JSONObject
import app.uselexora.mobile.R

internal object MobileModelControls {
    fun model(selection: JSONObject?, models: List<JSONObject>): JSONObject? = selection?.let { selected ->
        models.firstOrNull { it.optString("modelId") == selected.optString("modelId") && it.optString("providerId") == selected.optString("providerId") }
    }

    fun resolve(selection: JSONObject, models: List<JSONObject>): JSONObject {
        val resolved = JSONObject(selection.toString())
        val options = model(selection, models)?.optJSONArray("reasoningOptions") ?: return resolved
        if (selection.opt("reasoning") is String) return resolved
        val values = (0 until options.length()).map { options.getString(it) }
        val reasoning = values.firstOrNull { it == "medium" } ?: values.firstOrNull { it != "off" } ?: values.firstOrNull()
        return resolved.put("reasoning", reasoning ?: JSONObject.NULL)
    }

    fun parameters(model: JSONObject, reasoning: String?, tier: String?): JSONObject {
        val reasons = model.optJSONArray("reasoningOptions")
        val tiers = model.optJSONArray("serviceTiers")
        val supportedReasoning = reasoning?.takeIf { value -> reasons != null && (0 until reasons.length()).any { reasons.optString(it) == value } }
        val supportedTier = tier?.takeIf { value -> tiers != null && (0 until tiers.length()).any { tiers.optJSONObject(it)?.optString("id") == value } }
        return JSONObject().put("providerId", model.getString("providerId")).put("modelId", model.getString("modelId"))
            .put("reasoning", supportedReasoning ?: JSONObject.NULL).put("serviceTier", supportedTier ?: JSONObject.NULL)
    }

    fun supportsFast(selection: JSONObject?, models: List<JSONObject>): Boolean {
        val tiers = model(selection, models)?.optJSONArray("serviceTiers") ?: return false
        return (0 until tiers.length()).any { tiers.getJSONObject(it).optString("id") == "priority" }
    }

    fun reasoningLabel(value: String): String = when (value) {
        "off", "none" -> mobileText(R.string.reasoning_off)
        "minimal" -> mobileText(R.string.reasoning_minimal)
        "low" -> mobileText(R.string.reasoning_low)
        "medium" -> mobileText(R.string.reasoning_medium)
        "high" -> mobileText(R.string.reasoning_high)
        "xhigh" -> mobileText(R.string.reasoning_xhigh)
        "max" -> mobileText(R.string.reasoning_max)
        "auto" -> mobileText(R.string.reasoning_auto)
        "adaptive" -> mobileText(R.string.reasoning_adaptive)
        else -> value
    }
}
