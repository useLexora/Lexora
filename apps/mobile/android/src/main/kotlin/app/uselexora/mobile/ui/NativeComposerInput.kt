package app.uselexora.mobile.ui

import android.view.Gravity
import android.view.ViewGroup
import android.widget.EditText
import androidx.compose.foundation.layout.*
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText

@Composable
internal fun NativeComposerInput(
    composer: EditText,
    enabled: Boolean,
    maxHeight: Dp,
    fullscreen: Boolean,
    onToggleFullscreen: () -> Unit,
    modifier: Modifier = Modifier,
    onFocusChanged: (Boolean) -> Unit,
) {
    val focusChanged by rememberUpdatedState(onFocusChanged)
    DisposableEffect(composer) {
        val previous = composer.onFocusChangeListener
        val listener = android.view.View.OnFocusChangeListener { view, value ->
            focusChanged(value)
            previous?.onFocusChange(view, value)
        }
        composer.onFocusChangeListener = listener
        onDispose {
            if (composer.onFocusChangeListener === listener) composer.onFocusChangeListener = previous
        }
    }
    val density = LocalDensity.current
    val body = MaterialTheme.typography.bodyLarge
    val textSize = with(density) { body.fontSize.toPx() }
    val lineHeight = with(density) { body.lineHeight.toPx().toInt() }
    val textColor = MaterialTheme.colorScheme.onSurface.toArgb()
    val hintColor = MaterialTheme.colorScheme.onSurfaceVariant.toArgb()
    Row(modifier.fillMaxWidth().testTag(if (fullscreen) "composer-fullscreen" else "composer-compact"), verticalAlignment = Alignment.Top) {
        AndroidView(
            factory = {
                (composer.parent as? ViewGroup)?.removeView(composer)
                composer.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
                composer
            },
            update = { input ->
                input.setTextColor(textColor)
                input.setHintTextColor(hintColor)
                input.includeFontPadding = false
                input.typeface = android.graphics.Typeface.create("sans-serif", android.graphics.Typeface.NORMAL)
                if (input.textSize != textSize) input.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, textSize)
                androidx.core.widget.TextViewCompat.setLineHeight(input, lineHeight)
                input.setBackgroundColor(android.graphics.Color.TRANSPARENT)
                input.hint = mobileText(R.string.label_what_would_you_like_lexora_to_do)
                input.isEnabled = enabled
                input.minLines = 1
                input.maxLines = if (fullscreen) Int.MAX_VALUE else 6
                input.gravity = Gravity.TOP or Gravity.START
            },
            modifier = Modifier.weight(1f).then(if (fullscreen) Modifier.fillMaxHeight() else Modifier.heightIn(min = 44.dp.coerceAtMost(maxHeight), max = maxHeight))
                .padding(horizontal = 10.dp).testTag("input"),
        )
        IconButton(
            onClick = onToggleFullscreen,
            modifier = Modifier.size(48.dp).testTag(if (fullscreen) "exit-fullscreen-editor" else "fullscreen-editor"),
        ) {
            Icon(desktopSymbol(if (fullscreen) DesktopSymbol.Minimize else DesktopSymbol.Maximize),
                mobileText(if (fullscreen) R.string.mobile_exit_fullscreen_editor else R.string.mobile_fullscreen_editor),
                Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
