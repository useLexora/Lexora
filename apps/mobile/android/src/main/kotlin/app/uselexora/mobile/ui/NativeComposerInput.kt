package app.uselexora.mobile.ui

import android.view.Gravity
import android.view.ViewGroup
import android.widget.EditText
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import app.uselexora.mobile.R
import app.uselexora.mobile.i18n.mobileText

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun NativeComposerInput(
    composer: EditText,
    enabled: Boolean,
    hasAttachments: Boolean,
    maxHeight: Dp,
    tight: Boolean,
    onFocusChanged: (Boolean) -> Unit,
) {
    var focused by remember(composer) { mutableStateOf(composer.hasFocus()) }
    var hasText by remember(composer) { mutableStateOf(composer.text.isNotEmpty()) }
    var collapsed by remember(composer) { mutableStateOf(false) }
    val focusChanged by rememberUpdatedState(onFocusChanged)
    val keyboard = LocalSoftwareKeyboardController.current
    DisposableEffect(composer) {
        val previous = composer.onFocusChangeListener
        val listener = android.view.View.OnFocusChangeListener { view, value ->
            focused = value
            if (value) collapsed = false
            focusChanged(value)
            previous?.onFocusChange(view, value)
        }
        val watcher = object : android.text.TextWatcher {
            override fun beforeTextChanged(text: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(text: CharSequence?, start: Int, before: Int, count: Int) { hasText = !text.isNullOrEmpty() }
            override fun afterTextChanged(text: android.text.Editable?) = Unit
        }
        composer.onFocusChangeListener = listener
        composer.addTextChangedListener(watcher)
        onDispose {
            composer.removeTextChangedListener(watcher)
            if (composer.onFocusChangeListener === listener) composer.onFocusChangeListener = previous
        }
    }
    val expanded = !collapsed && (focused || hasText || hasAttachments)
    val collapse = {
        collapsed = true
        composer.clearFocus()
        keyboard?.hide()
        Unit
    }
    BackHandler(expanded && !WindowInsets.isImeVisible) { collapse() }
    val density = LocalDensity.current
    val body = MaterialTheme.typography.bodyLarge
    val textSize = with(density) { body.fontSize.toPx() }
    val lineHeight = with(density) { body.lineHeight.toPx().toInt() }
    val textColor = MaterialTheme.colorScheme.onSurface.toArgb()
    val hintColor = MaterialTheme.colorScheme.onSurfaceVariant.toArgb()
    Row(Modifier.fillMaxWidth().testTag(if (expanded) "composer-editing" else "composer-compact"), verticalAlignment = Alignment.Top) {
        AndroidView(
            factory = { (composer.parent as? ViewGroup)?.removeView(composer); composer },
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
                input.maxLines = if (expanded) 6 else 1
                input.gravity = Gravity.TOP or Gravity.START
            },
            modifier = Modifier.weight(1f).heightIn(min = if (expanded && !tight) 72.dp.coerceAtMost(maxHeight) else 44.dp.coerceAtMost(maxHeight), max = maxHeight)
                .padding(horizontal = 10.dp).testTag("input"),
        )
        if (expanded || hasText || hasAttachments) IconButton(
            onClick = { if (expanded) collapse() else { collapsed = false; composer.requestFocus(); keyboard?.show() } },
            modifier = Modifier.size(48.dp).testTag(if (expanded) "collapse-editor" else "expand-editor"),
        ) {
            Icon(if (expanded) Icons.Outlined.ExpandLess else Icons.Outlined.ExpandMore,
                mobileText(if (expanded) R.string.mobile_collapse_editor else R.string.mobile_expand_editor))
        }
    }
}
