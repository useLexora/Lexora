package app.uselexora.mobile.ui

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.LinkOff
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.MotionDurationScale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import app.uselexora.mobile.session.MobileConnectionPhase

internal val ServiceMarkSize = 16.dp

@Composable
internal fun ServiceConnectionMark(state: MobileUiState, muted: Color, technical: Boolean = false) {
    val context = LocalContext.current
    val skin = MobileAppearance.skinId
    val dark = LocalMobileDarkTheme.current
    val ink = remember(context, skin, dark) { Color(BuiltinSkins.get(context, skin).variant(dark).connectionSignal) }
    val modifier = Modifier.size(ServiceMarkSize)
    when {
        state.connected -> Icon(Icons.Outlined.Check, null, modifier, tint = ink)
        state.connectionPhase == MobileConnectionPhase.Connecting || state.connectionPhase == MobileConnectionPhase.Retrying -> {
            val motion = rememberCoroutineScope().coroutineContext[MotionDurationScale]?.scaleFactor ?: 1f
            val cycle = if (motion > 0f) rememberInfiniteTransition(label = "service signal").animateFloat(
                initialValue = 0f, targetValue = 1f, animationSpec = infiniteRepeatable(tween(1500, easing = LinearEasing)), label = "signal sweep",
            ) else null
            Canvas(modifier.testTag("service-signal")) {
                val u = size.minDimension / 16f
                for (i in 0..2) {
                    val alpha = cycle?.let {
                        val t = (it.value + 1f - i * .14f) % 1f
                        val rise = (t / .16f).coerceIn(0f, 1f)
                        val fall = ((.65f - t) / .27f).coerceIn(0f, 1f)
                        .42f + .58f * minOf(rise, fall)
                    } ?: 1f
                    val x = (3f + i * 5f) * u
                    val (start, end) = if (technical) {
                        Offset(x, 13f * u) to Offset(x, (10f - 3.5f * i) * u)
                    } else when (i) {
                        0 -> Offset(3f * u, 7.8f * u) to Offset(3.8f * u, 2.8f * u)
                        1 -> Offset(7f * u, 9f * u) to Offset(11.2f * u, 4f * u)
                        else -> Offset(9.2f * u, 12.7f * u) to Offset(14f * u, 11.3f * u)
                    }
                    drawLine(ink, start, end, 2.5f * u, if (technical) StrokeCap.Square else StrokeCap.Round, alpha = alpha)
                }
            }
        }
        else -> Icon(Icons.Outlined.LinkOff, null, modifier, tint = muted)
    }
}
