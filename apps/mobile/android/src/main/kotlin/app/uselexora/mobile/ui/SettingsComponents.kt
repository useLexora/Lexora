package app.uselexora.mobile.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.indication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.KeyboardArrowRight
import androidx.compose.material.icons.outlined.KeyboardArrowDown
import androidx.compose.material.icons.outlined.OpenInNew
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp

@Composable
internal fun HeaderAction(label: String, icon: ImageVector, modifier: Modifier = Modifier, action: () -> Unit) {
    val interaction = remember { MutableInteractionSource() }
    Box(
        modifier.size(48.dp).semantics { contentDescription = label }
            .clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = action),
        contentAlignment = Alignment.Center,
    ) {
        Box(Modifier.size(36.dp).clip(CircleShape).background(MaterialTheme.colorScheme.surfaceContainerHigh)
            .indication(interaction, ripple()), contentAlignment = Alignment.Center) {
            Icon(icon, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
internal fun SettingsHeader(title: String, backLabel: String, close: () -> Unit) {
    Row(Modifier.fillMaxWidth().heightIn(min = 56.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        HeaderAction(backLabel, Icons.AutoMirrored.Outlined.ArrowBack, action = close)
        Text(title, Modifier.weight(1f).padding(horizontal = 8.dp, vertical = 12.dp).semantics { heading() }, style = MaterialTheme.typography.titleMedium)
    }
}

@Composable
internal fun SettingsSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column {
        Text(title, Modifier.padding(start = 16.dp, bottom = 8.dp).semantics { heading() }, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Surface(shape = RoundedCornerShape(16.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh) {
            Column(content = content)
        }
    }
}

internal enum class SettingsRowKind { Navigation, Selection, ExternalLink, Action, ReadOnly }

@Composable
internal fun SettingsRow(
    title: String,
    icon: ImageVector,
    subtitle: String? = null,
    kind: SettingsRowKind = SettingsRowKind.Navigation,
    enabled: Boolean = true,
    tag: String? = null,
    divider: Boolean = true,
    action: () -> Unit = {},
) {
    val interactive = kind != SettingsRowKind.ReadOnly
    val color = if (interactive && !enabled) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface
    Column {
        Row(
            Modifier.fillMaxWidth().heightIn(min = 56.dp)
                .then(if (tag != null) Modifier.testTag(tag) else Modifier)
                .then(if (interactive) Modifier.clickable(enabled = enabled, role = Role.Button, onClick = action) else Modifier.semantics(mergeDescendants = true) {})
                .padding(horizontal = 16.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Icon(icon, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(title, style = MaterialTheme.typography.bodyLarge, color = color)
                if (!subtitle.isNullOrBlank()) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            when (kind) {
                SettingsRowKind.Navigation -> Icon(Icons.AutoMirrored.Outlined.KeyboardArrowRight, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                SettingsRowKind.Selection -> Icon(Icons.Outlined.KeyboardArrowDown, null, Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                SettingsRowKind.ExternalLink -> Icon(Icons.Outlined.OpenInNew, null, Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                else -> Unit
            }
        }
        if (divider) {
            val dividerColor = MaterialTheme.colorScheme.outlineVariant
            HorizontalDivider(Modifier.padding(horizontal = 16.dp), color = dividerColor.copy(alpha = dividerColor.alpha * 0.7f))
        }
    }
}
