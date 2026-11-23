package app.uselexora.mobile.ui

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.min
import kotlin.math.roundToInt

internal data class SkinHome(
    val layout: SkinHomeLayout,
    val typography: SkinHomeTypography,
    val surfaces: Map<String, SkinSurfaceStyle>,
    val iconStyle: String = "rounded",
) {
    operator fun get(slot: String): SkinSurfaceStyle = surfaces.getValue(slot)
}

internal data class SkinInsets(val left: Float, val top: Float, val right: Float, val bottom: Float)
internal data class SkinRegion(val x: Float, val y: Float, val width: Float, val height: Float) {
    fun overlaps(other: SkinRegion): Boolean = x < other.x + other.width && x + width > other.x && y < other.y + other.height && y + height > other.y
}

internal data class SkinHomeLayout(
    val headerFlow: String,
    val heroAlignment: String,
    val actionArrangement: String,
    val pageInset: Float,
    val gap: Float,
    val heroMinHeight: Float,
    val heroAspectRatio: Float,
    val actionMinHeight: Float,
    val shortcutMinHeight: Float,
    val pageTop: Float,
    val pageBottom: Float,
    val headerHeight: Float,
    val headerPadding: SkinInsets,
    val brandIconSize: Float,
    val connectionMinHeight: Float,
    val connectionPadding: SkinInsets,
    val connectionGap: Float,
    val serviceLayout: String,
    val serviceWidth: Float,
    val spaceWidth: Float,
    val serviceHeight: Float,
    val spaceHeight: Float,
    val serviceContentBounds: SkinRegion,
    val spaceContentBounds: SkinRegion,
    val spaceVerticalAlignment: String,
    val settingsLabel: Boolean,
    val settingsWidth: Float,
    val heroPromptBounds: SkinRegion,
    val heroActionBounds: SkinRegion,
    val heroIconSize: Float,
    val shortcutBadge: String,
    val actionPadding: SkinInsets,
    val actionIconGap: Float,
    val actionCountGap: Float,
    val actionsPadding: SkinInsets,
    val actionsGap: Float,
    val shortcutPadding: SkinInsets,
    val shortcutsPadding: SkinInsets,
    val shortcutGap: Float,
    val centerShortcuts: Boolean,
    val footerHeight: Float,
) {
    fun stackActions(widthDp: Float, fontScale: Float): Boolean = widthDp / fontScale.coerceAtLeast(1f) < 290f
    fun stackHeader(widthDp: Float, fontScale: Float): Boolean = headerFlow == "stacked" || widthDp / fontScale.coerceAtLeast(1f) < 330f
    fun inlineWidths(): Pair<Float, Float> {
        val total = (serviceWidth + spaceWidth).coerceAtLeast(1f)
        return serviceWidth / total to spaceWidth / total
    }
    fun heroHeight(promptHeight: Float, actionHeight: Float, width: Float = 0f): Float =
        maxOf(heroMinHeight, if (heroAspectRatio > 0f) width / heroAspectRatio else 0f, promptHeight / heroPromptBounds.height, actionHeight / heroActionBounds.height)
}

internal data class SkinHomeTypography(
    val brandSize: Float, val titleSize: Float, val labelSize: Float, val weight: Int,
    val fontFamily: String?, val brandFontFamily: String?, val brandItalic: Boolean,
    val brandWeight: Int, val promptSize: Float, val serviceSize: Float, val countSize: Float,
    val promptItalic: Boolean, val countAspectRatio: Float,
    val titleWeight: Int, val spaceSize: Float,
)
internal data class SkinPathCommand(val op: String, val values: List<Float>)
internal data class SkinShape(val type: String, val radius: Float = 0f, val cut: Float = 0f, val commands: List<SkinPathCommand> = emptyList())
internal data class SkinFill(val colors: List<Long>, val angle: Float)
internal data class SkinBorder(val color: Long, val width: Float, val inset: Float = 0f)
internal data class SkinShadow(val color: Long, val x: Float, val y: Float)
internal data class SkinLayer(val bounds: List<Float>, val shape: SkinShape, val fill: SkinFill, val border: SkinBorder?, val opacity: Float)
internal data class SkinSurfaceImage(val path: String, val insets: List<Int>?)
internal data class SkinSurfaceStyle(
    val shape: SkinShape,
    val fill: SkinFill,
    val foreground: Long,
    val muted: Long,
    val border: SkinBorder?,
    val insetBorder: SkinBorder?,
    val shadow: SkinShadow?,
    val layers: List<SkinLayer>,
    val image: SkinSurfaceImage? = null,
    val icon: Long = foreground,
)

internal fun decodeSkinHome(document: JSONObject?, assetRoot: String = ""): SkinHome? {
    if (document == null) return null
    return runCatching {
        require(assetRoot.isEmpty() || assetRoot.matches(Regex("skins/[a-z0-9]+(?:-[a-z0-9]+)*/")))
        require(document.getDouble("schemaVersion") == 1.0)
        val layout = document.getJSONObject("layout")
        val typography = document.getJSONObject("typography")
        val surfaces = document.getJSONObject("surfaces")
        val gap = layout.bounded("gap", 0f, 24f)
        val prompt = layout.region("heroPromptBounds", SkinRegion(.14f, .12f, .72f, .2f))
        val action = layout.region("heroActionBounds", SkinRegion(.1f, .4f, .8f, .45f))
        require(!prompt.overlaps(action))
        val weight = typography.boundedInt("weight", 500, 900)
        SkinHome(
            SkinHomeLayout(
                headerFlow = layout.choice("headerFlow", setOf("stacked", "inline")),
                heroAlignment = layout.choice("heroAlignment", setOf("leading", "centered")),
                actionArrangement = layout.choice("actionArrangement", setOf("stacked", "inline")),
                pageInset = layout.bounded("pageInset", 0f, 24f), gap = gap,
                heroMinHeight = layout.bounded("heroMinHeight", 128f, 320f),
                heroAspectRatio = layout.optionalNumber("heroAspectRatio", .5f, 4f, 0f),
                actionMinHeight = layout.bounded("actionMinHeight", 64f, 180f),
                shortcutMinHeight = layout.bounded("shortcutMinHeight", 48f, 100f),
                pageTop = layout.optionalNumber("pageTop", 0f, 48f, 12f),
                pageBottom = layout.optionalNumber("pageBottom", 0f, 48f, 12f),
                headerHeight = layout.optionalNumber("headerHeight", 48f, 160f, 76f),
                headerPadding = layout.insets("headerPadding", 64f, SkinInsets(12f, 14f, 12f, 14f)),
                brandIconSize = layout.optionalNumber("brandIconSize", 24f, 64f, 24f),
                connectionMinHeight = layout.optionalNumber("connectionMinHeight", 0f, 200f, 0f),
                connectionPadding = layout.insets("connectionPadding", 64f),
                connectionGap = layout.optionalNumber("connectionGap", 0f, 24f, 10f),
                serviceLayout = layout.optionalChoice("serviceLayout", setOf("compact", "panel"), "panel"),
                serviceWidth = layout.optionalNumber("serviceWidth", .25f, 1f, 1f),
                spaceWidth = layout.optionalNumber("spaceWidth", .25f, 1f, 1f),
                serviceHeight = layout.optionalNumber("serviceHeight", 48f, 160f, 48f),
                spaceHeight = layout.optionalNumber("spaceHeight", 48f, 160f, 48f),
                serviceContentBounds = layout.region("serviceContentBounds", SkinRegion(.06f, .1f, .88f, .8f)),
                spaceContentBounds = layout.region("spaceContentBounds", SkinRegion(.1f, .1f, .8f, .8f)),
                spaceVerticalAlignment = layout.optionalChoice("spaceVerticalAlignment", setOf("top", "center", "bottom"), "center"),
                settingsLabel = layout.optionalBoolean("settingsLabel", false),
                settingsWidth = layout.optionalNumber("settingsWidth", 48f, 120f, 48f),
                heroPromptBounds = prompt, heroActionBounds = action,
                heroIconSize = layout.optionalNumber("heroIconSize", 32f, 64f, 48f),
                shortcutBadge = layout.optionalChoice("shortcutBadge", setOf("badge", "allBadge"), "badge"),
                actionPadding = layout.insets("actionPadding", 48f, SkinInsets(16f, 20f, 16f, 20f)),
                actionIconGap = layout.optionalNumber("actionIconGap", 0f, 24f, 9f),
                actionCountGap = layout.optionalNumber("actionCountGap", 0f, 24f, 7f),
                actionsPadding = layout.insets("actionsPadding", 64f),
                actionsGap = layout.optionalNumber("actionsGap", 0f, 24f, gap),
                shortcutPadding = layout.insets("shortcutPadding", 64f, SkinInsets(28f, 10f, 28f, 10f)),
                shortcutsPadding = layout.insets("shortcutsPadding", 64f),
                shortcutGap = layout.optionalNumber("shortcutGap", 0f, 24f, gap),
                centerShortcuts = layout.optionalBoolean("centerShortcuts", false),
                footerHeight = layout.optionalNumber("footerHeight", 0f, 120f, 0f),
            ),
            SkinHomeTypography(
                typography.bounded("brandSize", 24f, 48f), typography.bounded("titleSize", 26f, 56f),
                typography.bounded("labelSize", 16f, 28f), weight,
                typography.asset("fontFamily", assetRoot, setOf("ttf", "otf")),
                typography.asset("brandFontFamily", assetRoot, setOf("ttf", "otf")),
                typography.optionalBoolean("brandItalic", false),
                if (typography.has("brandWeight")) typography.boundedInt("brandWeight", 100, 900) else weight,
                typography.optionalNumber("promptSize", 14f, 26f, 18f),
                typography.optionalNumber("serviceSize", 12f, 22f, 14f),
                typography.optionalNumber("countSize", 16f, 28f, 21f),
                typography.optionalBoolean("promptItalic", false),
                typography.optionalNumber("countAspectRatio", 1f, 2f, 1f),
                if (typography.has("titleWeight")) typography.boundedInt("titleWeight", 100, 900) else weight,
                typography.optionalNumber("spaceSize", 12f, 24f, typography.optionalNumber("serviceSize", 12f, 22f, 14f) + 2f),
            ),
            buildMap {
                for (slot in listOf("background", "header", "service", "space", "hero", "approvals", "questions", "unread", "marked", "all", "settings", "heroAction", "heroIcon", "badge", "allBadge")) {
                    put(slot, surfaces.getJSONObject(slot).surfaceStyle(assetRoot))
                }
                for (slot in listOf("connection", "actions", "shortcuts", "footer")) {
                    if (surfaces.has(slot)) put(slot, surfaces.getJSONObject(slot).surfaceStyle(assetRoot))
                }
            },
            document.optionalChoice("iconStyle", setOf("rounded", "technical"), "rounded"),
        )
    }.getOrNull()
}

private fun JSONObject.surfaceStyle(assetRoot: String) = SkinSurfaceStyle(
    getJSONObject("shape").skinShape(), getJSONObject("fill").skinFill(),
    getString("foreground").skinColor(), getString("muted").skinColor(),
    optJSONObject("border")?.skinBorder(), optJSONObject("insetBorder")?.skinBorder(inset = true),
    optJSONObject("shadow")?.let { SkinShadow(it.getString("color").skinColor(), it.bounded("x", -8f, 8f), it.bounded("y", -8f, 8f)) },
    optJSONArray("layers")?.let { layers ->
        require(layers.length() <= 16)
        List(layers.length()) { i ->
            val layer = layers.getJSONObject(i)
            val bounds = layer.getJSONArray("bounds").numbers(4)
            require(bounds[0] in -1f..1f && bounds[1] in -1f..1f && bounds[2] in 0.001f..2f && bounds[3] in 0.001f..2f)
            SkinLayer(bounds, layer.getJSONObject("shape").skinShape(), layer.getJSONObject("fill").skinFill(),
                layer.optJSONObject("border")?.skinBorder(), layer.bounded("opacity", 0f, 1f))
        }
    } ?: emptyList(),
    if (has("image")) getJSONObject("image").let { image ->
        SkinSurfaceImage(resolveSkinAsset(assetRoot, image.getString("path"), setOf("png", "webp", "jpg", "jpeg")),
            if (image.has("insets")) image.getJSONArray("insets").numbers(4).map { require(it in 0f..4096f && it % 1f == 0f); it.toInt() } else null)
    } else null,
    optString("icon", getString("foreground")).skinColor(),
)

internal fun resolveSkinAsset(root: String, path: String, extensions: Set<String>): String {
    require(root.isEmpty() || root.matches(Regex("skins/[a-z0-9]+(?:-[a-z0-9]+)*/")))
    require(path.length in 1..192)
    require(path.split('/').all { it != "." && it != ".." && it.matches(Regex("[a-zA-Z0-9][a-zA-Z0-9._-]*")) })
    require(path.substringAfterLast('.', "").lowercase() in extensions)
    return root + path
}

internal data class SkinImagePatch(val sx: Int, val sy: Int, val sw: Int, val sh: Int, val dx: Int, val dy: Int, val dw: Int, val dh: Int)

internal fun skinImagePatches(sourceWidth: Int, sourceHeight: Int, width: Int, height: Int, insets: List<Int>?): List<SkinImagePatch> {
    require(sourceWidth > 0 && sourceHeight > 0 && width >= 0 && height >= 0)
    if (width == 0 || height == 0) return emptyList()
    if (insets == null) return listOf(SkinImagePatch(0, 0, sourceWidth, sourceHeight, 0, 0, width, height))
    require(insets.size == 4 && insets.all { it in 0..4096 })
    val (l, t, r, b) = insets
    require(l + r < sourceWidth && t + b < sourceHeight)
    val scale = min(width.toFloat() / sourceWidth, height.toFloat() / sourceHeight)
    val sx = listOf(0, l, sourceWidth - r, sourceWidth)
    val sy = listOf(0, t, sourceHeight - b, sourceHeight)
    val dx = listOf(0, (l * scale).roundToInt(), width - (r * scale).roundToInt(), width)
    val dy = listOf(0, (t * scale).roundToInt(), height - (b * scale).roundToInt(), height)
    return buildList {
        for (y in 0..2) for (x in 0..2) {
            val patch = SkinImagePatch(sx[x], sy[y], sx[x + 1] - sx[x], sy[y + 1] - sy[y], dx[x], dy[y], dx[x + 1] - dx[x], dy[y + 1] - dy[y])
            if (patch.sw > 0 && patch.sh > 0 && patch.dw > 0 && patch.dh > 0) add(patch)
        }
    }
}

private fun JSONObject.skinShape(): SkinShape = when (val type = getString("type")) {
    "rounded" -> SkinShape(type, radius = bounded("radius", 0f, 160f))
    "cut" -> SkinShape(type, cut = bounded("cut", 0f, 32f))
    "path" -> {
        val array = getJSONArray("commands")
        require(array.length() in 4..32)
        val commands = List(array.length()) { index ->
            val command = array.getJSONObject(index)
            val op = command.getString("op")
            val arity = when (op) { "M", "L" -> 2; "C" -> 6; "Q" -> 4; "Z" -> 0; else -> error("Unknown path operation") }
            SkinPathCommand(op, command.getJSONArray("values").numbers(arity).also { values -> require(values.all { it in 0f..1f }) })
        }
        require(commands.first().op == "M" && commands.last().op == "Z" && commands.drop(1).none { it.op == "M" } && commands.dropLast(1).none { it.op == "Z" })
        SkinShape(type, commands = commands)
    }
    else -> error("Unknown shape")
}

private fun JSONObject.skinFill(): SkinFill {
    val values = getJSONArray("colors")
    require(values.length() in 1..4)
    return SkinFill(List(values.length()) { values.getString(it).skinColor() }, bounded("angle", 0f, 360f))
}
private fun JSONObject.skinBorder(inset: Boolean = false) = SkinBorder(
    getString("color").skinColor(), bounded("width", 0.5f, 4f), if (inset) bounded("inset", 2f, 12f) else 0f,
)
private fun JSONObject.choice(key: String, choices: Set<String>): String = getString(key).also { require(it in choices) }
private fun JSONObject.optionalChoice(key: String, choices: Set<String>, default: String): String = if (has(key)) choice(key, choices) else default
private fun JSONObject.optionalBoolean(key: String, default: Boolean): Boolean = if (has(key)) get(key).let { require(it is Boolean); it } else default
private fun JSONObject.optionalNumber(key: String, min: Float, max: Float, default: Float): Float = if (has(key)) bounded(key, min, max) else default
private fun JSONObject.asset(key: String, root: String, extensions: Set<String>): String? = if (has(key)) resolveSkinAsset(root, getString(key), extensions) else null
private fun JSONObject.bounded(key: String, min: Float, max: Float): Float {
    val value = getDouble(key)
    require(value.isFinite() && value >= min && value <= max)
    return value.toFloat()
}
private fun JSONObject.boundedInt(key: String, min: Int, max: Int): Int = bounded(key, min.toFloat(), max.toFloat()).let { require(it % 1f == 0f); it.toInt() }
private fun JSONObject.insets(key: String, max: Float, default: SkinInsets = SkinInsets(0f, 0f, 0f, 0f)): SkinInsets {
    if (!has(key)) return default
    val values = getJSONArray(key).numbers(4).also { require(it.all { value -> value in 0f..max }) }
    return SkinInsets(values[0], values[1], values[2], values[3])
}
private fun JSONObject.region(key: String, default: SkinRegion): SkinRegion {
    if (!has(key)) return default
    val v = getJSONArray(key).numbers(4)
    require(v[0] in 0f..1f && v[1] in 0f..1f && v[2] in .1f..1f && v[3] in .1f..1f)
    require(v[0] + v[2] <= 1.00001f && v[1] + v[3] <= 1.00001f)
    return SkinRegion(v[0], v[1], v[2], v[3])
}
private fun JSONArray.numbers(size: Int): List<Float> {
    require(length() == size)
    return List(size) { index -> getDouble(index).also { require(it.isFinite()) }.toFloat().also { require(it.isFinite()) } }
}
internal fun String.skinColor(): Long {
    require(matches(Regex("#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?")))
    val raw = substring(1).toLong(16)
    return if (length == 7) 0xFF000000L or raw else ((raw and 255L) shl 24) or (raw ushr 8)
}
