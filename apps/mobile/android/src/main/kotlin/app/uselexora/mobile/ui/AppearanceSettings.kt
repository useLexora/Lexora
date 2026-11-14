package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AppearanceSettings(close: () -> Unit) {
    val context = LocalContext.current
    ModalBottomSheet(onDismissRequest = close, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.surfaceContainer, shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp)) {
        Column(Modifier.fillMaxWidth().testTag("appearance-settings")) {
            Row(Modifier.fillMaxWidth().padding(start = 24.dp, end = 12.dp, bottom = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(mobileText(R.string.label_appearance_language), Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                IconButton(onClick = close) { Icon(Icons.Outlined.Close, mobileText(R.string.label_close_settings)) }
            }
            Column(Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(horizontal = 24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text(mobileText(R.string.label_theme), style = MaterialTheme.typography.titleMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                    AppearanceOption(mobileText(R.string.label_light), Icons.Outlined.LightMode, MobileAppearance.theme == "light", Modifier.weight(1f).heightIn(min = 88.dp).testTag("theme-light")) { MobileAppearance.selectTheme(context, "light") }
                    AppearanceOption(mobileText(R.string.label_dark), Icons.Outlined.DarkMode, MobileAppearance.theme == "dark", Modifier.weight(1f).heightIn(min = 88.dp).testTag("theme-dark")) { MobileAppearance.selectTheme(context, "dark") }
                    AppearanceOption(mobileText(R.string.label_system), Icons.Outlined.DesktopWindows, MobileAppearance.theme == "system", Modifier.weight(1f).heightIn(min = 88.dp).testTag("theme-system")) { MobileAppearance.selectTheme(context, "system") }
                }
                Text((if (MobileAppearance.theme == "system") mobileText(R.string.label_following_your_system_theme) else mobileText(R.string.label_using_a_fixed_theme)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.height(4.dp))
                Text(mobileText(R.string.label_language), style = MaterialTheme.typography.titleMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(9.dp)) {
                    AppearanceOption(mobileText(R.string.mobile_language_chinese), null, MobileAppearance.language == "zh", Modifier.weight(1f).heightIn(min = 56.dp).testTag("language-zh")) { MobileAppearance.selectLanguage(context, "zh"); (context as? android.app.Activity)?.recreate() }
                    AppearanceOption(mobileText(R.string.language_english), null, MobileAppearance.language == "en", Modifier.weight(1f).heightIn(min = 56.dp).testTag("language-en")) { MobileAppearance.selectLanguage(context, "en"); (context as? android.app.Activity)?.recreate() }
                }
                Spacer(Modifier.height(24.dp))
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .6f))
            Button(onClick = close, Modifier.fillMaxWidth().padding(24.dp).height(50.dp), shape = RoundedCornerShape(topStart = 16.dp, topEnd = 16.dp, bottomEnd = 6.dp, bottomStart = 16.dp)) { Text(mobileText(R.string.label_done)) }
        }
    }
}

@Composable
private fun AppearanceOption(label: String, icon: ImageVector?, selected: Boolean, modifier: Modifier, click: () -> Unit) {
    val color = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface
    Surface(onClick = click, selected = selected, modifier = modifier, shape = RoundedCornerShape(15.dp), color = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.background,
        border = BorderStroke(if (selected) 2.dp else 1.dp, if (selected) color else MaterialTheme.colorScheme.outlineVariant)) {
        Column(Modifier.padding(horizontal = 4.dp, vertical = 12.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(9.dp, Alignment.CenterVertically)) {
            if (icon != null) Icon(icon, null, Modifier.size(23.dp), tint = color)
            Text(label, style = MaterialTheme.typography.labelLarge, color = color)
        }
    }
}
