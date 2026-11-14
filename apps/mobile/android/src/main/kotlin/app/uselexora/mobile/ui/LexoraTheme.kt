package app.uselexora.mobile.ui

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.core.view.WindowCompat

private fun typography(bodySize: Int, bodyLineHeight: Int) = Typography(
    headlineMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 24.sp, lineHeight = 32.sp, letterSpacing = (-0.6).sp),
    titleLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.SemiBold, fontSize = 21.sp, lineHeight = 28.sp),
    titleMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Medium, fontSize = 16.sp, lineHeight = 25.sp),
    titleSmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 21.sp),
    bodyLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = bodySize.sp, lineHeight = bodyLineHeight.sp),
    bodyMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 14.sp, lineHeight = 22.sp),
    bodySmall = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 13.sp, lineHeight = 19.sp),
    labelLarge = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Medium, fontSize = 14.sp, lineHeight = 20.sp),
    labelMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 13.sp, lineHeight = 19.sp),
    labelSmall = TextStyle(fontFamily = FontFamily.SansSerif, fontWeight = FontWeight.Normal, fontSize = 12.sp, lineHeight = 16.sp),
)

@Composable
fun LexoraTheme(darkTheme: Boolean = MobileAppearance.isDark(isSystemInDarkTheme()), content: @Composable () -> Unit) {
    val view = LocalView.current
    val windowFocused = LocalWindowInfo.current.isWindowFocused
    val context = LocalContext.current
    val colors = remember(darkTheme) {
        val palette = MobileTheme.palette(context, darkTheme)
        fun c(name: String) = MobileTheme.color(palette, name)
        (if (darkTheme) darkColorScheme() else lightColorScheme()).copy(
            primary = c("accent"), onPrimary = c("on-accent"),
            primaryContainer = c("selected"), onPrimaryContainer = c("selected-fg"),
            secondary = c("success"), onSecondary = c("on-accent"),
            secondaryContainer = c("success-surface"), onSecondaryContainer = c("success"),
            background = c("canvas"), onBackground = c("fg"),
            surface = c("surface"), onSurface = c("strong"),
            surfaceVariant = c("subtle"), onSurfaceVariant = c("muted"),
            surfaceContainer = c("composer"), surfaceContainerLow = c("surface"),
            surfaceContainerHigh = c("raised"),
            outline = c("border-strong"), outlineVariant = c("border"),
            tertiary = c("warning"), onTertiary = c("on-accent"),
            tertiaryContainer = c("warning-surface"), onTertiaryContainer = c("warning"),
            error = c("danger"), errorContainer = c("danger-surface"), onErrorContainer = c("danger"),
        )
    }
    val type = remember { MobileTheme.typography(context).let { typography(it.getInt("bodySize"), it.getInt("bodyLineHeight")) } }
    if (!view.isInEditMode) SideEffect {
        val window = (view.context as? Activity)?.window
        if (window != null) {
            WindowCompat.setDecorFitsSystemWindows(window, false)
            @Suppress("DEPRECATION")
            window.statusBarColor = colors.background.toArgb()
            @Suppress("DEPRECATION")
            window.navigationBarColor = android.graphics.Color.TRANSPARENT
            if (windowFocused) WindowCompat.getInsetsController(window, window.decorView).apply {
                isAppearanceLightStatusBars = !darkTheme
                isAppearanceLightNavigationBars = !darkTheme
            }
        }
    }
    MaterialTheme(
        colorScheme = colors,
        typography = type,
        shapes = Shapes(
            extraSmall = RoundedCornerShape(4.dp), small = RoundedCornerShape(8.dp),
            medium = RoundedCornerShape(12.dp), large = RoundedCornerShape(16.dp), extraLarge = RoundedCornerShape(22.dp),
        ),
        content = { CompositionLocalProvider(LocalContentColor provides colors.onSurface, content = content) },
    )
}
