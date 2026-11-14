package app.uselexora.mobile.protocol

import org.json.JSONArray
import org.json.JSONObject

class ProtocolSchemas(val document: JSONObject) {
    fun request(method: String, params: JSONObject): Boolean {
        val contract = if (method == "initialize") document.getJSONObject("initialize") else document.getJSONObject("methods").optJSONObject(method) ?: return false
        return valid(params, contract.getJSONObject("input"))
    }
    fun response(method: String, result: Any?): Boolean {
        val contract = if (method == "initialize") document.getJSONObject("initialize") else document.getJSONObject("methods").optJSONObject(method) ?: return false
        return valid(result, contract.getJSONObject("output"))
    }
    fun content(value: JSONObject): Boolean = valid(value, document.getJSONObject("content"))
    fun valid(value: Any?, schema: JSONObject, root: JSONObject = schema, depth: Int = 0): Boolean {
        if (depth > 64) return false
        if (schema.has("\$ref")) {
            val ref = schema.getString("\$ref")
            if (!ref.startsWith("#/")) return false
            var target: Any = root
            for (segment in ref.removePrefix("#/").split('/')) {
                val key = segment.replace("~1", "/").replace("~0", "~")
                target = when (val parent = target) {
                    is JSONObject -> parent.opt(key)
                    is JSONArray -> key.toIntOrNull()?.let { parent.opt(it) }
                    else -> null
                } ?: return false
            }
            return valid(value, target as? JSONObject ?: return false, root, depth + 1)
        }
        fun alternatives(key: String): List<Boolean> = schema.optJSONArray(key)?.let { options -> (0 until options.length()).map { valid(value, options.getJSONObject(it), root, depth + 1) } } ?: emptyList()
        if (schema.has("anyOf") && alternatives("anyOf").none { it }) return false
        if (schema.has("oneOf") && alternatives("oneOf").count { it } != 1) return false
        if (schema.has("allOf") && alternatives("allOf").any { !it }) return false
        if (schema.has("const") && !same(value, schema.get("const"))) return false
        schema.optJSONArray("enum")?.let { allowed -> if ((0 until allowed.length()).none { same(value, allowed.get(it)) }) return false }
        val type = schema.opt("type")
        if (type is JSONArray && (0 until type.length()).none { matches(value, type.getString(it)) }) return false
        if (type is String && !matches(value, type)) return false
        if (value == null || value == JSONObject.NULL) return true
        when (value) {
            is String -> {
                if (schema.has("minLength") && value.length < schema.getInt("minLength")) return false
                if (schema.has("maxLength") && value.length > schema.getInt("maxLength")) return false
                schema.optString("pattern").takeIf { it.isNotEmpty() }?.let { pattern ->
                    val flags = schema.optString("x-pattern-flags")
                    val options = (if ('i' in flags) java.util.regex.Pattern.CASE_INSENSITIVE else 0) or (if ('m' in flags) java.util.regex.Pattern.MULTILINE else 0) or (if ('s' in flags) java.util.regex.Pattern.DOTALL else 0)
                    if (!java.util.regex.Pattern.compile(pattern, options).matcher(value).find()) return false
                    if (pattern == "^(?:0|[1-9]\\d{0,18})$" && runCatching { ProductProtocol.revision(value) }.isFailure) return false
                }
                if (schema.optString("format") == "date-time" && runCatching { java.time.Instant.parse(value) }.isFailure) return false
            }
            is Number -> {
                val number = value.toDouble()
                if (!number.isFinite()) return false
                if (schema.has("minimum") && number < schema.getDouble("minimum")) return false
                if (schema.has("maximum") && number > schema.getDouble("maximum")) return false
                if (schema.has("exclusiveMinimum") && number <= schema.getDouble("exclusiveMinimum")) return false
                if (schema.has("exclusiveMaximum") && number >= schema.getDouble("exclusiveMaximum")) return false
            }
            is JSONArray -> {
                if (schema.has("minItems") && value.length() < schema.getInt("minItems")) return false
                if (schema.has("maxItems") && value.length() > schema.getInt("maxItems")) return false
                schema.optJSONObject("items")?.let { item -> if ((0 until value.length()).any { !valid(value.get(it), item, root, depth + 1) }) return false }
            }
            is JSONObject -> {
                schema.optJSONArray("required")?.let { required -> if ((0 until required.length()).any { !value.has(required.getString(it)) }) return false }
                val properties = schema.optJSONObject("properties") ?: JSONObject()
                for (key in value.keys()) {
                    schema.optJSONObject("propertyNames")?.let { if (!valid(key, it, root, depth + 1)) return false }
                    val property = properties.optJSONObject(key)
                    if (property != null && !valid(value.get(key), property, root, depth + 1)) return false
                    if (property == null && schema.opt("additionalProperties") == false) return false
                    if (property == null) schema.optJSONObject("additionalProperties")?.let { if (!valid(value.get(key), it, root, depth + 1)) return false }
                }
            }
        }
        return true
    }
    private fun same(left: Any?, right: Any?): Boolean = if (left is Number && right is Number) left.toDouble() == right.toDouble() else left == right
    private fun matches(value: Any?, type: String): Boolean = when (type) {
        "null" -> value == null || value == JSONObject.NULL
        "object" -> value is JSONObject
        "array" -> value is JSONArray
        "string" -> value is String
        "boolean" -> value is Boolean
        "number" -> value is Number
        "integer" -> value is Number && value.toDouble() == kotlin.math.floor(value.toDouble())
        else -> false
    }
}
