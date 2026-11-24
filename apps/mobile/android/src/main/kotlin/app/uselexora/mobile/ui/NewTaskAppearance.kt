package app.uselexora.mobile.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CutCornerShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.FolderOpen
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawOutline
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

@Composable
internal fun NewTaskIntro(state: MobileUiState, style: NewTaskStyle?, onChooseSpace: () -> Unit) {
    BoxWithConstraints(Modifier.fillMaxSize().padding(horizontal = 24.dp)) {
        val available = (maxHeight - if (state.spaceVisible) 56.dp else 0.dp).coerceAtLeast(0.dp)
        val artBottom = minOf(maxHeight * .53f, available)
        val width = minOf(maxWidth, 400.dp) * (style?.widthFraction ?: 0f)
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())) {
            Box(Modifier.fillMaxWidth().height(artBottom), contentAlignment = Alignment.BottomStart) {
                if (style != null && artBottom > 0.dp) key(style.illustration.path) {
                    val bitmap = skinBitmap(style.illustration)
                    if (bitmap != null) {
                        val ratio = bitmap.width.toFloat() / bitmap.height
                        val w = minOf(width, artBottom * ratio)
                        Image(bitmap, contentDescription = null, Modifier.size(w, w / ratio).testTag("new-task-art-ready"))
                    }
                }
            }
            if (state.spaceVisible) {
                Spacer(Modifier.height(8.dp))
                TextButton(onClick = onChooseSpace, enabled = state.spaceEnabled,
                    colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant),
                    contentPadding = PaddingValues(0.dp), modifier = Modifier.heightIn(min = 48.dp).testTag("space")) {
                    Icon(Icons.Outlined.FolderOpen, null, Modifier.size(17.dp))
                    Spacer(Modifier.width(8.dp))
                    Text(state.spaceLabel, Modifier.weight(1f, fill = false), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Icon(Icons.Outlined.ExpandMore, null, Modifier.size(16.dp))
                }
            }
        }
    }
}

@Composable
internal fun ComposerSurface(style: NewTaskStyle?, focused: Boolean, modifier: Modifier, content: @Composable () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val shape = if (style?.cutCorners == true) CutCornerShape(9.dp) else RoundedCornerShape(18.dp)
    val frame = if (style == null) modifier else modifier.testTag("new-task-composer").drawWithCache {
        val edge = shape.createOutline(size, layoutDirection, this)
        val shift = style.offset.dp.toPx()
        onDrawBehind { translate(shift, shift) { drawOutline(edge, Color(style.underlay)) } }
    }
    val line = when {
        focused && style != null -> colors.primary
        focused -> colors.primary.copy(alpha = .5f)
        style != null -> Color(style.outline)
        else -> colors.outlineVariant
    }
    Surface(modifier = frame, shape = shape, color = colors.surfaceContainer,
        border = BorderStroke(if (focused && style != null) 2.dp else 1.dp, line), content = content)
}
