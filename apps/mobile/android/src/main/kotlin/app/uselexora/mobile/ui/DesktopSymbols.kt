package app.uselexora.mobile.ui

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.HelpOutline
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import org.json.JSONObject

internal enum class DesktopSymbol(val key: String) {
    Back("back"), More("more"), Check("check"), Close("close"), Search("search"), Add("add"), ArrowUp("arrowUp"), ChevronDown("chevronDown"), Maximize("maximize"), Minimize("minimize"),
    ReadOnly("readOnly"), ManualApproval("manualApproval"), SmartApproval("smartApproval"), FullAccess("fullAccess"), Partners("partners")
}

@Composable
internal fun executionIcon(config: JSONObject): ImageVector =
    if (config.length() == 0) Icons.Outlined.HelpOutline else desktopSymbol(executionSymbol(config))

private fun executionSymbol(config: JSONObject) = when {
    config.optString("executionProfile") == "full_access" -> DesktopSymbol.FullAccess
    config.optString("executionProfile") == "read_only" -> DesktopSymbol.ReadOnly
    config.optString("approvalPolicy") == "manual" -> DesktopSymbol.ManualApproval
    else -> DesktopSymbol.SmartApproval
}

@Composable
internal fun desktopSymbol(symbol: DesktopSymbol): ImageVector {
    val context = LocalContext.current
    return remember(context, symbol) {
        val definition = context.assets.open("reader/icons.json").bufferedReader().use { JSONObject(it.readText()).getJSONObject(symbol.key) }
        val width = definition.getDouble("width").toFloat()
        val height = definition.getDouble("height").toFloat()
        ImageVector.Builder(symbol.key, width.dp, height.dp, width, height).apply {
            val paths = definition.getJSONArray("paths")
            for (index in 0 until paths.length()) {
                val path = paths.getJSONObject(index)
                val strokeWidth = path.optDouble("strokeWidth", 0.0).toFloat()
                addPath(PathParser().parsePathString(path.getString("data")).toNodes(),
                    fill = if (strokeWidth == 0f) SolidColor(Color.Black) else null,
                    stroke = if (strokeWidth > 0f) SolidColor(Color.Black) else null,
                    strokeLineWidth = strokeWidth, strokeLineCap = StrokeCap.Round, strokeLineJoin = StrokeJoin.Round)
            }
        }.build()
    }
}
