package app.uselexora.mobile.ui

import org.json.JSONObject

internal data class BuiltinSkinVariant(val palette: JSONObject, val home: JSONObject?)

internal data class BuiltinSkin(
    val id: String,
    val version: Int,
    val name: Map<String, String>,
    private val variants: Map<String, BuiltinSkinVariant>,
) {
    fun variant(dark: Boolean): BuiltinSkinVariant = variants.getValue(if (dark) "dark" else "light")
    fun label(language: String): String = name[language] ?: name.getValue("en")

    companion object {
        fun parse(document: JSONObject): BuiltinSkin {
            require(document.get("schemaVersion") == 1) { "Unsupported skin schema" }
            val id = document.get("id") as? String
            require(id != null && validSkinId(id)) { "Invalid skin id" }
            val version = document.get("version")
            require(version is Int && version > 0) { "Invalid skin version" }
            val names = document.getJSONObject("name")
            val name = listOf("zh", "en").associateWith { language ->
                val value = names.get(language)
                require(value is String && value.isNotBlank() && value.length <= 160) { "Invalid skin name" }
                value
            }
            val variants = document.getJSONObject("variants")
            return BuiltinSkin(id, version, name, listOf("light", "dark").associateWith { mode ->
                val variant = variants.getJSONObject(mode)
                val palette = variant.getJSONObject("palette")
                validatePalette(palette)
                val home = variant.get("home")
                require(home === JSONObject.NULL || home is JSONObject) { "Skin home must be an object or null" }
                BuiltinSkinVariant(palette, home as? JSONObject)
            })
        }
    }
}

internal class MobileSkinCatalog private constructor(val skins: List<BuiltinSkin>) {
    fun get(id: String?): BuiltinSkin = skins.firstOrNull { it.id == id } ?: skins.first { it.id == DEFAULT_ID }

    companion object {
        const val DEFAULT_ID = "paper"

        fun load(readAsset: (String) -> String): MobileSkinCatalog {
            val index = JSONObject(readAsset("skins/index.json"))
            require(index.get("schemaVersion") == 1) { "Unsupported skin index schema" }
            val entries = index.getJSONArray("skins")
            val ids = (0 until entries.length()).map { position ->
                val id = entries.get(position)
                require(id is String && validSkinId(id)) { "Invalid skin index id" }
                id
            }
            require(ids.toSet().size == ids.size && DEFAULT_ID in ids) { "Skin index requires unique ids and paper" }
            return MobileSkinCatalog(ids.map { id ->
                BuiltinSkin.parse(JSONObject(readAsset("skins/$id/skin.json"))).also {
                    require(it.id == id) { "Skin id does not match its index entry" }
                }
            })
        }
    }
}

private val skinIdPattern = Regex("[a-z][a-z0-9]*(?:-[a-z0-9]+)*")
private fun validSkinId(id: String): Boolean = id.length <= 80 && skinIdPattern.matches(id)
private val colorPattern = Regex("#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?")
private val nativeColors = setOf(
    "accent", "on-accent", "selected", "selected-fg", "success", "success-surface", "canvas", "fg",
    "surface", "strong", "subtle", "muted", "composer", "raised", "border-strong", "border",
    "warning", "warning-surface", "danger", "danger-surface", "reading", "reading-fg",
)

private fun validatePalette(palette: JSONObject) {
    val colors = palette.getJSONObject("colors")
    require(nativeColors.all(colors::has)) { "Incomplete skin colors" }
    for (key in colors.keys()) {
        val value = colors.get(key)
        require(value is String && colorPattern.matches(value)) { "Invalid skin color: $key" }
    }
    val variables = palette.getJSONObject("variables")
    require(listOf("--buddy-surface-canvas", "--ms-background", "--buddy-font-body", "--buddy-font-mono").all(variables::has)) { "Incomplete skin variables" }
    for (key in variables.keys()) {
        val value = variables.get(key)
        require(key.startsWith("--") && value is String && value.isNotBlank()) { "Invalid skin variable: $key" }
    }
}
