package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.MobileStrings
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

internal object MobileAppearance {
    var theme by mutableStateOf("system")
        private set
    val language get() = MobileStrings.language
    fun load(context: Context) {
        val prefs = context.getSharedPreferences("appearance", Context.MODE_PRIVATE)
        theme = prefs.getString("theme", "system").takeIf { it in setOf("system", "light", "dark") } ?: "system"
        MobileStrings.language = prefs.getString("language", "zh").takeIf { it in setOf("zh", "en") } ?: "zh"
    }
    fun selectTheme(context: Context, value: String) {
        if (value !in setOf("system", "light", "dark")) return
        context.getSharedPreferences("appearance", Context.MODE_PRIVATE).edit().putString("theme", value).apply()
        theme = value
    }
    fun selectLanguage(context: Context, value: String) {
        if (value !in setOf("zh", "en") || value == language) return
        context.getSharedPreferences("appearance", Context.MODE_PRIVATE).edit().putString("language", value).apply()
        MobileStrings.language = value
    }
    fun isDark(system: Boolean) = when (theme) { "light" -> false; "dark" -> true; else -> system }
}
