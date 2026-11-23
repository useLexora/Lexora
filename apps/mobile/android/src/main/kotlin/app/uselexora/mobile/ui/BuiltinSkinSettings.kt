package app.uselexora.mobile.ui

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText

@Composable
internal fun BuiltinSkinSettings(close: () -> Unit) {
    val context = LocalContext.current
    val selected = MobileAppearance.skinId
    BackHandler(onBack = close)
    Surface(Modifier.fillMaxSize().testTag("builtin-skins"), color = MaterialTheme.colorScheme.background) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Box(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 6.dp), contentAlignment = Alignment.Center) {
                HeaderAction(mobileText(R.string.label_back), Icons.AutoMirrored.Outlined.ArrowBack, Modifier.align(Alignment.CenterStart), plain = true, action = close)
                Text(mobileText(R.string.label_skin), Modifier.semantics { heading() }, style = MaterialTheme.typography.titleLarge)
            }
            LazyVerticalGrid(
                columns = GridCells.Adaptive((94f * LocalDensity.current.fontScale.coerceAtLeast(1f)).dp),
                modifier = Modifier.weight(1f).widthIn(max = 700.dp).fillMaxWidth().selectableGroup(),
                contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 10.dp, bottom = 24.dp),
                horizontalArrangement = Arrangement.spacedBy(10.dp), verticalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                items(BuiltinSkins.list(context), key = { it.id }) { skin ->
                    SkinCover(skin, skin.id == selected) { MobileAppearance.selectSkin(context, skin.id) }
                }
            }
        }
    }
}

@Composable
private fun SkinCover(skin: BuiltinSkin, active: Boolean, apply: () -> Unit) {
    val variant = skin.variant(LocalMobileDarkTheme.current)
    val home = remember(skin, variant) { decodeSkinHome(variant.home, "skins/${skin.id}/") }
    Box(Modifier.fillMaxWidth().aspectRatio(.55f).clip(RoundedCornerShape(7.dp))
        .background(MobileTheme.color(variant.palette, "canvas")).testTag("skin-${skin.id}")
        .selectable(active, role = Role.RadioButton, onClick = apply)) {
        BoxWithConstraints(Modifier.matchParentSize().testTag("skin-preview-${skin.id}").clearAndSetSemantics {}) {
            // Keep the miniature artwork at phone proportions; the accessible caption uses system type size.
            CompositionLocalProvider(LocalDensity provides Density(constraints.maxWidth / 390f, 1f)) {
                if (home == null) PaperCoverArt() else SkinCoverArt(home)
            }
        }
        Spacer(Modifier.matchParentSize().background(Brush.verticalGradient(
            .54f to Color.Transparent, .84f to Color.Black.copy(alpha = .62f), 1f to Color.Black.copy(alpha = .82f))))
        Text(skin.label(MobileAppearance.language), Modifier.align(Alignment.BottomStart).padding(10.dp),
            style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Normal, color = Color.White)
        if (active) {
            Row(Modifier.align(Alignment.TopEnd).padding(6.dp)
                .background(Color.Black.copy(alpha = .68f), RoundedCornerShape(4.dp))
                .padding(horizontal = 5.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                Icon(Icons.Outlined.Check, null, Modifier.size(12.dp), tint = Color.White)
                Text(mobileText(R.string.skin_in_use), style = MaterialTheme.typography.labelSmall, color = Color.White)
            }
        }
    }
}
