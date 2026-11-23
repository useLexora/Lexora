package app.uselexora.mobile.ui

import android.content.res.AssetManager
import android.util.LruCache
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight

internal data class SkinTypefaces(val body: FontFamily, val brand: FontFamily)
internal val LocalSkinTypefaces = staticCompositionLocalOf { SkinTypefaces(FontFamily.Default, FontFamily.Default) }

private object SkinTypefaceCache {
    private val cache = LruCache<String, FontFamily>(8)

    @OptIn(ExperimentalTextApi::class)
    fun load(assets: AssetManager, path: String, weights: List<Int>, style: FontStyle): FontFamily? {
        val key = "$path:$weights:$style"
        return cache.get(key) ?: runCatching {
            assets.open(path).use { require(it.available() <= 24 * 1024 * 1024) }
            FontFamily(weights.map { weight ->
                Font(path, assets, weight = FontWeight(weight), style = style, variationSettings = FontVariation.Settings(FontVariation.weight(weight)))
            })
        }.getOrNull()?.also { cache.put(key, it) }
    }
}

@Composable
internal fun WithSkinTypography(typography: SkinHomeTypography, content: @Composable () -> Unit) {
    val assets = LocalContext.current.assets
    val fonts = remember(assets, typography) {
        val weights = listOf(400, typography.weight, typography.titleWeight, typography.brandWeight).distinct().sorted()
        val body = typography.fontFamily?.let { SkinTypefaceCache.load(assets, it, weights, FontStyle.Normal) } ?: FontFamily.Default
        val brand = typography.brandFontFamily?.let {
            SkinTypefaceCache.load(assets, it, weights, if (typography.brandItalic) FontStyle.Italic else FontStyle.Normal)
        } ?: body
        SkinTypefaces(body, brand)
    }
    CompositionLocalProvider(LocalSkinTypefaces provides fonts, content = content)
}
