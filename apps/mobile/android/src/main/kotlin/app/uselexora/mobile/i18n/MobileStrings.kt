package app.uselexora.mobile.i18n

import android.content.Context
import android.content.res.Configuration
import android.content.res.Resources
import androidx.annotation.PluralsRes
import androidx.annotation.StringRes
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import java.util.Locale

internal interface MobileStringResources {
    fun text(@StringRes id: Int, language: String, arguments: Array<out Any?>): String
    fun quantity(@PluralsRes id: Int, language: String, count: Int, arguments: Array<out Any?>): String
}

internal object MobileStrings {
    var language by mutableStateOf("zh")
    val locale: Locale get() = Locale.forLanguageTag(language)
    private lateinit var source: MobileStringResources
    fun initialize(source: MobileStringResources) { this.source = source }
    fun initialize(context: Context) { initialize(AndroidMobileStringResources(context.applicationContext)) }
    fun text(id: Int, arguments: Array<out Any?>) = source.text(id, language, arguments)
    fun quantity(id: Int, count: Int, arguments: Array<out Any?>) = source.quantity(id, language, count, arguments)
    fun localizedContext(context: Context): Context {
        val language = context.getSharedPreferences("appearance", Context.MODE_PRIVATE).getString("language", "zh").takeIf { it in setOf("zh", "en") } ?: "zh"
        return context.createConfigurationContext(Configuration(context.resources.configuration).apply { setLocale(Locale.forLanguageTag(language)) })
    }
}

private class AndroidMobileStringResources(private val context: Context) : MobileStringResources {
    private val localized = mutableMapOf<String, Pair<Configuration, Resources>>()
    @Synchronized private fun resources(language: String): Resources {
        val configuration = Configuration(context.resources.configuration).apply { setLocale(Locale.forLanguageTag(language)) }
        localized[language]?.takeIf { it.first == configuration }?.let { return it.second }
        return context.createConfigurationContext(configuration).resources.also { localized[language] = configuration to it }
    }
    override fun text(id: Int, language: String, arguments: Array<out Any?>) = resources(language).getString(id, *arguments)
    override fun quantity(id: Int, language: String, count: Int, arguments: Array<out Any?>) = resources(language).getQuantityString(id, count, *arguments)
}

internal fun mobileText(@StringRes id: Int, vararg arguments: Any?): String = MobileStrings.text(id, arguments)
internal fun mobileQuantity(@PluralsRes id: Int, count: Int, vararg arguments: Any?): String = MobileStrings.quantity(id, count, if (arguments.isEmpty()) arrayOf(count) else arguments)
