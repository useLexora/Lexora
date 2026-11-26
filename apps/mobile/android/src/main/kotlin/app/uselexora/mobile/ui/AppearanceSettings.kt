package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.unit.dp

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun AppearanceSettings(openDownloads: (() -> Unit)? = null, close: () -> Unit) {
    val context = LocalContext.current
    var languagePicker by remember { mutableStateOf(false) }
    var aboutOpen by rememberSaveable { mutableStateOf(false) }
    var skinsOpen by rememberSaveable { mutableStateOf(false) }
    var notificationsOpen by rememberSaveable { mutableStateOf(false) }
    if (notificationsOpen) {
        NotificationSettingsPage { notificationsOpen = false }
        return
    }
    if (skinsOpen) {
        BuiltinSkinSettings { skinsOpen = false }
        return
    }
    if (aboutOpen) {
        AboutSettings { aboutOpen = false }
        return
    }
    BackHandler { close() }
    Surface(Modifier.fillMaxSize().testTag("appearance-settings"), color = MaterialTheme.colorScheme.background) {
        Column {
            SettingsHeader(mobileText(R.string.mobile_phone_settings), mobileText(R.string.label_close_settings), close)
            Column(
                Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(16.dp),
                verticalArrangement = Arrangement.spacedBy(24.dp),
            ) {
                SettingsSection(mobileText(R.string.label_theme)) {
                    Row(Modifier.fillMaxWidth().padding(12.dp).height(IntrinsicSize.Min).selectableGroup(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf("light" to R.string.label_light, "dark" to R.string.label_dark, "system" to R.string.label_system).forEach { (mode, label) ->
                            ThemeOption(mode, mobileText(label), Modifier.weight(1f).fillMaxHeight()) { MobileAppearance.selectTheme(context, mode) }
                        }
                    }
                    SettingsRow(mobileText(R.string.label_skin), Icons.Outlined.Palette,
                        BuiltinSkins.current(context).label(MobileAppearance.language),
                        kind = SettingsRowKind.Navigation, tag = "skin-settings", divider = false) { skinsOpen = true }
                }
                SettingsSection(mobileText(R.string.label_language)) {
                    SettingsRow(mobileText(R.string.label_language), Icons.Outlined.Language,
                        mobileText(if (MobileAppearance.language == "zh") R.string.mobile_language_chinese else R.string.language_english),
                        kind = SettingsRowKind.Selection, tag = "language-selector", divider = false) { languagePicker = true }
                }
                if (openDownloads != null) DownloadsSettingsRow(openDownloads)
                Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
                    SettingsRow(mobileText(R.string.settings_notifications_title), Icons.Outlined.Notifications,
                        tag = "notification-settings", divider = false) { notificationsOpen = true }
                }
                Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
                    SettingsRow(mobileText(R.string.mobile_about_lexora), Icons.Outlined.Info, tag = "about-lexora", divider = false) { aboutOpen = true }
                }
            }
        }
    }
    if (languagePicker) ModalBottomSheet(
        onDismissRequest = { languagePicker = false },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh,
    ) {
        Column(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, bottom = 24.dp).selectableGroup()) {
            Text(mobileText(R.string.label_language), Modifier.padding(12.dp), style = MaterialTheme.typography.titleLarge)
            listOf("zh" to R.string.mobile_language_chinese, "en" to R.string.language_english).forEach { (language, label) ->
                ActionRow(mobileText(label), Icons.Outlined.Language, checked = MobileAppearance.language == language,
                    tag = "language-$language", modifier = Modifier.semantics { selected = MobileAppearance.language == language; role = Role.RadioButton }) {
                    languagePicker = false
                    if (MobileAppearance.language != language) {
                        MobileAppearance.selectLanguage(context, language)
                        (context as? android.app.Activity)?.recreate()
                    }
                }
            }
        }
    }
}

@Composable
private fun ThemeOption(mode: String, label: String, modifier: Modifier, click: () -> Unit) {
    val selected = MobileAppearance.theme == mode
    Surface(
        onClick = click, selected = selected,
        modifier = modifier.testTag("theme-$mode").semantics { role = Role.RadioButton },
        shape = RoundedCornerShape(12.dp),
        color = if (selected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surface,
        border = BorderStroke(2.dp, if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
    ) {
        Column(Modifier.padding(6.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Box {
                key(MobileAppearance.theme) {
                    ThemePreview(mode, Modifier.fillMaxWidth().height(70.dp).clip(RoundedCornerShape(7.dp)).testTag("theme-preview-$mode"))
                }
                if (selected) Surface(Modifier.align(Alignment.TopEnd).padding(3.dp), shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.primary) {
                    Icon(Icons.Outlined.Check, mobileText(R.string.label_selected), Modifier.padding(2.dp).size(16.dp), tint = MaterialTheme.colorScheme.onPrimary)
                }
            }
            Text(label, Modifier.padding(bottom = 4.dp), style = MaterialTheme.typography.labelLarge,
                color = if (selected) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurface)
        }
    }
}

@Composable
internal fun ThemePreview(mode: String, modifier: Modifier, skinId: String = MobileAppearance.skinId) {
    val context = LocalContext.current
    val skin = remember(context, skinId) { BuiltinSkins.get(context, skinId) }
    val light = skin.variant(false).palette
    val dark = skin.variant(true).palette
    Canvas(modifier) {
        fun drawPreview(darkMode: Boolean) {
            val palette = if (darkMode) dark else light
            fun c(key: String) = MobileTheme.color(palette, key)
            val w = size.width
            val h = size.height
            drawRect(c("canvas"))
            drawRoundRect(c("raised"), Offset(w * .08f, h * .1f), Size(w * .84f, h * .2f), CornerRadius(4.dp.toPx()))
            drawRoundRect(c("muted"), Offset(w * .18f, h * .18f), Size(w * .45f, h * .035f), CornerRadius(1.dp.toPx()))
            drawRoundRect(c("accent"), Offset(w * .12f, h * .42f), Size(w * .55f, h * .055f), CornerRadius(2.dp.toPx()))
            drawRoundRect(c("muted"), Offset(w * .12f, h * .55f), Size(w * .7f, h * .035f), CornerRadius(1.dp.toPx()))
            drawRoundRect(c("muted"), Offset(w * .12f, h * .65f), Size(w * .45f, h * .035f), CornerRadius(1.dp.toPx()))
            drawRoundRect(c("border"), Offset(w * .08f, h * .8f), Size(w * .84f, h * .14f), CornerRadius(4.dp.toPx()), style = androidx.compose.ui.graphics.drawscope.Stroke(1.dp.toPx()))
        }
        drawPreview(mode == "dark")
        if (mode == "system") clipPath(Path().apply {
            moveTo(size.width * .7f, 0f); lineTo(size.width, 0f); lineTo(size.width, size.height); lineTo(size.width * .3f, size.height); close()
        }) { drawPreview(true) }
    }
}
