package app.uselexora.mobile.ui

import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import app.uselexora.mobile.BuildConfig
import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText

@Composable
internal fun AboutSettings(close: () -> Unit) {
    val context = LocalContext.current
    val links = LocalUriHandler.current
    fun openLink(url: String) {
        try { links.openUri(url) }
        catch (_: IllegalArgumentException) { Toast.makeText(context, mobileText(R.string.mobile_could_not_open_link), Toast.LENGTH_SHORT).show() }
    }
    BackHandler { close() }
    Surface(Modifier.fillMaxSize().testTag("about-settings"), color = MaterialTheme.colorScheme.background) {
        Column {
            SettingsHeader(mobileText(R.string.mobile_about_lexora), mobileText(R.string.label_back), close)
            Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp, vertical = 24.dp), verticalArrangement = Arrangement.spacedBy(24.dp)) {
                Column(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Image(painterResource(R.mipmap.ic_lexora), null, Modifier.size(64.dp).clip(RoundedCornerShape(18.dp)))
                    Spacer(Modifier.height(16.dp))
                    Text("Lexora", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold)
                    Spacer(Modifier.height(4.dp))
                    Text(mobileText(R.string.mobile_about_version, BuildConfig.VERSION_NAME), Modifier.testTag("app-version"), style = MaterialTheme.typography.bodySmall, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(12.dp))
                    Text(mobileText(R.string.mobile_about_tagline), style = MaterialTheme.typography.bodyMedium, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
                        Column {
                            SettingsRow(mobileText(R.string.mobile_about_website), Icons.Outlined.Language, kind = SettingsRowKind.ExternalLink, tag = "about-website") { openLink("https://uselexora.app/") }
                            SettingsRow(mobileText(R.string.mobile_about_source), Icons.Outlined.Code, kind = SettingsRowKind.ExternalLink, tag = "about-source") { openLink("https://github.com/useLexora/Lexora") }
                            SettingsRow(mobileText(R.string.mobile_about_feedback), Icons.Outlined.Feedback, kind = SettingsRowKind.ExternalLink, tag = "about-feedback", divider = false) { openLink("https://github.com/useLexora/Lexora/issues") }
                        }
                    }
                    Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
                        SettingsRow(mobileText(R.string.mobile_about_license), Icons.Outlined.Description, "AGPL-3.0-only", kind = SettingsRowKind.ExternalLink, tag = "about-license", divider = false) { openLink("https://github.com/useLexora/Lexora/blob/master/LICENSE") }
                    }
                }
            }
        }
    }
}
