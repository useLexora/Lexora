package app.uselexora.mobile.ui

import androidx.compose.foundation.Canvas
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Fill
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.lerp
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.unit.LayoutDirection
import kotlin.math.cos
import kotlin.math.sin

internal enum class SkinGlyph { Settings, Service, Down, Next, Arrow, Add, Approval, Question, Unread, Marked, All }

@Composable
internal fun SkinIcon(glyph: SkinGlyph, style: String, modifier: Modifier = Modifier, tint: Color = LocalContentColor.current) {
    val rtl = LocalLayoutDirection.current == LayoutDirection.Rtl
    Canvas(modifier) {
        val technical = style == "technical"
        val width = if (technical) 1.8f else 3f
        val ink = Brush.linearGradient(listOf(lerp(tint, Color.White, .08f), tint, lerp(tint, Color.Black, if (tint.luminance() > .5f) .05f else .14f)), Offset(0f, 2f), Offset(18f, 24f))
        fun outline(path: Path, strokeWidth: Float = width, filled: Boolean = false) {
            val pen = if (filled) Fill else Stroke(strokeWidth, cap = StrokeCap.Round, join = StrokeJoin.Round)
            if (technical) {
                translate(top = .45f) { drawPath(path, Color.Black.copy(alpha = .2f * tint.alpha), style = pen) }
                translate(top = -.25f) { drawPath(path, Color.White.copy(alpha = .22f * tint.alpha), style = pen) }
                drawPath(path, tint, style = pen)
            } else drawPath(path, ink, style = pen)
        }
        fun line(vararg points: Float, strokeWidth: Float = width) {
            outline(Path().apply {
                moveTo(points[0], points[1])
                for (i in 2 until points.size step 2) lineTo(points[i], points[i + 1])
            }, strokeWidth)
        }
        scale(size.width / 24f, size.height / 24f, pivot = Offset.Zero) {
            when (glyph) {
                SkinGlyph.Settings -> {
                    val points = buildList {
                        repeat(if (technical) 8 else 6) { tooth ->
                            val step = if (technical) 45.0 else 60.0
                            for ((angle, radius) in listOf(-.39 to 7.7f, -.22 to 10.2f, .22 to 10.2f, .39 to 7.7f)) {
                                val radians = Math.toRadians(tooth * step - 90 + angle * step)
                                add(Offset(12f + radius * cos(radians).toFloat(), 12f + radius * sin(radians).toFloat()))
                            }
                        }
                    }
                    val gear = Path().apply {
                        val start = (points.last() + points.first()) / 2f
                        moveTo(start.x, start.y)
                        points.forEachIndexed { index, point ->
                            val end = (point + points[(index + 1) % points.size]) / 2f
                            if (technical) lineTo(point.x, point.y) else quadraticTo(point.x, point.y, end.x, end.y)
                        }
                        close()
                        if (technical) { fillType = PathFillType.EvenOdd; addOval(Rect(8.4f, 8.4f, 15.6f, 15.6f)) }
                    }
                    outline(gear, 2.4f, filled = technical)
                    if (!technical) drawCircle(ink, 3.2f, Offset(12f, 12f), style = Stroke(2.4f))
                }
                SkinGlyph.Service -> {
                    drawRoundRect(ink, Offset(3.5f, 3f), Size(17f, 13f), CornerRadius(1.6f), style = Stroke(2.6f))
                    drawRect(ink, Offset(9f, 16f), Size(6f, 3f))
                    drawRoundRect(ink, Offset(1.5f, 18.5f), Size(21f, 3f), CornerRadius(1.2f))
                    drawLine(Color.White.copy(alpha = .8f), Offset(10f, 19.5f), Offset(14f, 19.5f), 1f, StrokeCap.Round)
                }
                SkinGlyph.Down -> if (technical) {
                    outline(Path().apply {
                        moveTo(5.8f, 8f); lineTo(18.2f, 8f); quadraticTo(19.4f, 8f, 18.6f, 9.3f)
                        lineTo(13f, 17f); quadraticTo(12f, 18.3f, 11f, 17f)
                        lineTo(5.4f, 9.3f); quadraticTo(4.6f, 8f, 5.8f, 8f); close()
                    }, filled = true)
                } else line(5f, 8.5f, 12f, 15.5f, 19f, 8.5f, strokeWidth = 3.2f)
                SkinGlyph.Next -> {
                    if (rtl) line(15f, 5f, 8f, 12f, 15f, 19f, strokeWidth = if (technical) 2.1f else 3.2f)
                    else line(9f, 5f, 16f, 12f, 9f, 19f, strokeWidth = if (technical) 2.1f else 3.2f)
                }
                SkinGlyph.Arrow -> {
                    if (rtl) { line(21f, 12f, 3f, 12f, strokeWidth = 3.5f); line(10.5f, 4.5f, 3f, 12f, 10.5f, 19.5f, strokeWidth = 3.5f) }
                    else { line(3f, 12f, 21f, 12f, strokeWidth = 3.5f); line(13.5f, 4.5f, 21f, 12f, 13.5f, 19.5f, strokeWidth = 3.5f) }
                }
                SkinGlyph.Add -> {
                    line(12f, 4f, 12f, 20f, strokeWidth = 3.4f)
                    line(4f, 12f, 20f, 12f, strokeWidth = 3.4f)
                }
                SkinGlyph.Approval -> {
                    if (technical) {
                        outline(Path().apply {
                            moveTo(8.5f, 4.8f); lineTo(6f, 4.8f); quadraticTo(4f, 4.8f, 4f, 6.8f)
                            lineTo(4f, 20f); quadraticTo(4f, 22f, 6f, 22f); lineTo(18f, 22f)
                            quadraticTo(20f, 22f, 20f, 20f); lineTo(20f, 6.8f); quadraticTo(20f, 4.8f, 18f, 4.8f); lineTo(15.5f, 4.8f)
                        })
                        drawRoundRect(tint, Offset(8.5f, 2f), Size(7f, 4.3f), CornerRadius(1.1f), style = Stroke(1.8f))
                        line(7.6f, 13f, 10.5f, 16f, 16.8f, 9.5f)
                    } else {
                        drawRoundRect(ink, Offset(3f, 3f), Size(18f, 18f), CornerRadius(4f), style = Stroke(2.9f))
                        line(7.5f, 12.5f, 10.5f, 15.2f, 16.8f, 8.8f, strokeWidth = 3.3f)
                    }
                }
                SkinGlyph.Question -> {
                    outline(Path().apply {
                        if (technical) {
                            moveTo(4.5f, 3f); lineTo(19.5f, 3f); quadraticTo(22f, 3f, 22f, 5.5f)
                            lineTo(22f, 16f); quadraticTo(22f, 18.5f, 19.5f, 18.5f)
                            lineTo(10f, 18.5f); lineTo(4f, 22f); lineTo(4f, 18.4f)
                            quadraticTo(2f, 18f, 2f, 16f); lineTo(2f, 5.5f); quadraticTo(2f, 3f, 4.5f, 3f)
                        } else {
                            moveTo(4.2f, 21f); lineTo(3.1f, 13f); cubicTo(1.4f, 1.8f, 20f, 1.4f, 21.3f, 10.5f)
                            cubicTo(22.4f, 17.2f, 15.8f, 19.7f, 9.4f, 18.1f)
                            lineTo(5.3f, 21.5f); quadraticTo(4.4f, 22f, 4.2f, 21f)
                        }
                        close()
                    }, if (technical) 1.8f else 2.7f)
                    for (x in listOf(7.5f, 12f, 16.5f)) drawCircle(tint, 1.2f, Offset(x, 11f))
                }
                SkinGlyph.Unread -> {
                    val radius = if (technical) 1f else 3.5f
                    if (!technical) drawRoundRect(if (tint.luminance() > .5f) tint.copy(alpha = .08f) else Color.White.copy(alpha = .9f), Offset(2.5f, 4f), Size(19f, 16f), CornerRadius(radius))
                    drawRoundRect(if (technical) Brush.linearGradient(listOf(tint, tint)) else ink, Offset(2.5f, 4f), Size(19f, 16f), CornerRadius(radius), style = Stroke(width))
                    if (technical) line(3.5f, 6f, 12f, 12.5f, 20.5f, 6f)
                    else outline(Path().apply { moveTo(3.5f, 6f); lineTo(10.6f, 12f); quadraticTo(12f, 13.3f, 13.4f, 12f); lineTo(20.5f, 6f) }, 3f)
                }
                SkinGlyph.Marked -> outline(Path().apply {
                    val radius = if (technical) 1f else 3.5f
                    moveTo(5f, 21.5f); lineTo(5f, 2.5f + radius); quadraticTo(5f, 2.5f, 5f + radius, 2.5f)
                    lineTo(19f - radius, 2.5f); quadraticTo(19f, 2.5f, 19f, 2.5f + radius)
                    lineTo(19f, 21.5f); lineTo(12f, 17.1f); close()
                }, if (technical) 1.8f else 3.2f)
                SkinGlyph.All -> if (technical) {
                    line(3f, 7.5f, 12f, 2.5f, 21f, 7.5f, 12f, 12.5f, 3f, 7.5f)
                    line(3f, 12.5f, 12f, 17.5f, 21f, 12.5f)
                    line(3f, 17.5f, 12f, 22.5f, 21f, 17.5f)
                } else {
                    for (x in listOf(2f, 14f)) for (y in listOf(2f, 14f)) drawRoundRect(ink, Offset(x, y), Size(8f, 8f), CornerRadius(3f))
                }
            }
        }
    }
}
