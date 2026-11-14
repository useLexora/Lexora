package app.uselexora.mobile.ui

import android.content.Context
import androidx.compose.ui.graphics.Color
import org.json.JSONObject

internal object MobileTheme {
    private var document: JSONObject? = null
    @Synchronized private fun document(context: Context): JSONObject = document ?: context.assets.open("reader/appearance.json").bufferedReader().use { JSONObject(it.readText()) }.also { document = it }
    fun palette(context: Context, dark: Boolean): JSONObject = document(context).getJSONObject(if (dark) "dark" else "light")
    fun typography(context: Context): JSONObject = document(context).getJSONObject("typography")
    fun color(palette: JSONObject, key: String): Color {
        val hex = palette.getJSONObject("colors").getString(key).removePrefix("#")
        val rgba = hex.toLong(16)
        return Color(if (hex.length == 8) ((rgba and 255) shl 24) or (rgba ushr 8) else 0xFF000000L or rgba)
    }
}
