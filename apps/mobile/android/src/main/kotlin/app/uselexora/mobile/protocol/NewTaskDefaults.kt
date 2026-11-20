package app.uselexora.mobile.protocol

import app.uselexora.mobile.network.ProductClient
import org.json.JSONObject

internal data class NewTaskDefaults(val execution: JSONObject?, val model: JSONObject?, val modelName: String?) {
    fun nameFor(selection: JSONObject?): String? = modelName?.takeIf {
        model != null && selection != null && selection.optString("providerId") == model.optString("providerId") &&
            selection.optString("modelId") == model.optString("modelId")
    }

    companion object {
        const val METHOD = "chat.getNewTaskDefaults"

        fun read(client: ProductClient): NewTaskDefaults {
            if (client.supports(METHOD)) {
                val value = client.call(METHOD, JSONObject())
                return NewTaskDefaults(ExecutionSettings.newTaskConfig(value), value.optJSONObject("modelSelection"), value.opt("modelDisplayName") as? String)
            }
            val legacy = if (client.supports("providers.getInputSelection")) client.call("providers.getInputSelection", JSONObject()).optJSONObject("modelSelection") else null
            return NewTaskDefaults(null, legacy, null)
        }
    }
}
