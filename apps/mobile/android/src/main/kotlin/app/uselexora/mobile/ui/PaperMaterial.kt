package app.uselexora.mobile.ui

import android.graphics.BitmapShader
import android.graphics.Matrix
import android.graphics.Shader
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.ShaderBrush
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.imageResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import app.uselexora.mobile.R

@Composable
internal fun PaperSurface(
    shape: Shape,
    modifier: Modifier = Modifier,
    colors: List<Color>,
    elevation: Dp = 0.dp,
    onClick: (() -> Unit)? = null,
    content: @Composable BoxScope.() -> Unit,
) {
    require(colors.isNotEmpty()) { "PaperSurface requires at least one color" }
    val fiber = ImageBitmap.imageResource(R.drawable.paper_fiber)
    val density = LocalDensity.current.density
    val grain = remember(fiber, density) {
        ShaderBrush(BitmapShader(fiber.asAndroidBitmap(), Shader.TileMode.REPEAT, Shader.TileMode.REPEAT).apply {
            setLocalMatrix(Matrix().apply {
                setScale(256f * density / fiber.width, 256f * density / fiber.height)
            })
        })
    }
    Box(
        modifier
            .shadow(
                elevation = elevation,
                shape = shape,
                clip = false,
                ambientColor = Color(0xFF21132F).copy(alpha = 0.5f),
                spotColor = Color(0xFF160C25).copy(alpha = 0.85f),
            )
            .then(if (onClick == null) Modifier else Modifier.clip(shape).clickable(role = Role.Button, onClick = onClick))
            .drawWithCache {
                val outline = shape.createOutline(size, layoutDirection, this)
                val edge = Path().apply {
                    when (outline) {
                        is Outline.Generic -> addPath(outline.path)
                        is Outline.Rectangle -> addRect(outline.rect)
                        is Outline.Rounded -> addRoundRect(outline.roundRect)
                    }
                }
                val stops = if (colors.size == 1) listOf(colors.first(), colors.first()) else colors
                val face = Brush.linearGradient(stops, Offset.Zero, Offset(size.width, size.height))
                val dark = colors.first().luminance() < 0.35f
                val sheen = Brush.radialGradient(
                    colors = listOf(Color.White.copy(alpha = if (dark) 0.06f else 0.18f), Color.Transparent),
                    center = Offset(size.width * 0.15f, 0f),
                    radius = size.maxDimension.coerceAtLeast(1f),
                )
                val rim = Brush.verticalGradient(
                    listOf(
                        Color.White.copy(alpha = if (dark) 0.28f else 0.72f),
                        Color(0xFFAA91BD).copy(alpha = 0.24f),
                        Color(0xFF241231).copy(alpha = if (dark) 0.58f else 0.24f),
                    ),
                )
                val edgeStroke = Stroke(width = 0.8.dp.toPx())
                onDrawBehind {
                    drawPath(edge, face)
                    drawPath(edge, sheen)
                    drawPath(edge, grain)
                    drawPath(edge, rim, style = edgeStroke)
                }
            },
        content = content,
    )
}

internal object PaperFolderShape : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val w = size.width
        val h = size.height
        val tab = with(density) { 15.dp.toPx() }.coerceAtMost(h * 0.18f).coerceAtMost(w * 0.15f)
        val r = with(density) { 6.dp.toPx() }.coerceAtMost(tab / 2)
        val bottom = with(density) { 1.dp.toPx() }.coerceAtMost(h / 4)
        return Outline.Generic(Path().apply {
            moveTo(0f, tab + r)
            quadraticBezierTo(0f, tab, r, tab - r)
            lineTo(tab - r, r)
            quadraticBezierTo(tab, 0f, tab + r, 0f)
            lineTo(w * 0.43f, 0f)
            quadraticBezierTo(w * 0.43f + r, 0f, w * 0.43f + r * 2, r)
            lineTo(w * 0.43f + tab, tab - r)
            quadraticBezierTo(w * 0.43f + tab + r, tab, w * 0.43f + tab + r * 2, tab)
            lineTo(w - r, tab)
            quadraticBezierTo(w, tab, w, tab + r)
            lineTo(w, h - bottom)
            quadraticBezierTo(w, h, w - bottom, h)
            lineTo(bottom, h)
            quadraticBezierTo(0f, h, 0f, h - bottom)
            close()
        })
    }
}

internal class PaperFoldShape(private val corner: Dp = 28.dp) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val w = size.width
        val h = size.height
        val fold = with(density) { corner.toPx() }.coerceIn(0f, size.minDimension / 2)
        val r = with(density) { 17.dp.toPx() }.coerceAtMost(size.minDimension / 4)
        return Outline.Generic(Path().apply {
            moveTo(r, 0f)
            lineTo(w - r, 0f)
            quadraticBezierTo(w, 0f, w, r)
            lineTo(w, h - fold)
            lineTo(w - fold, h)
            lineTo(r, h)
            quadraticBezierTo(0f, h, 0f, h - r)
            lineTo(0f, r)
            quadraticBezierTo(0f, 0f, r, 0f)
            close()
        })
    }
}

internal object PaperBookmarkShape : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val notch = with(density) { 10.dp.toPx() }.coerceAtMost(size.height / 3).coerceAtMost(size.width / 4)
        return Outline.Generic(Path().apply {
            moveTo(0f, 0f)
            lineTo(size.width, 0f)
            lineTo(size.width - notch, size.height / 2)
            lineTo(size.width, size.height)
            lineTo(0f, size.height)
            close()
        })
    }
}

@Composable
internal fun PaperCurl(modifier: Modifier = Modifier) {
    Box(modifier.drawWithCache {
        val x = size.width / 40f
        val y = size.height / 40f
        val fold = Path().apply {
            moveTo(x, 39f * y)
            cubicTo(10f * x, 29f * y, 5f * x, 12f * y, 13f * x, 7f * y)
            cubicTo(21f * x, 2f * y, 30f * x, 8f * y, 39f * x, y)
            close()
        }
        val shadow = Path().apply {
            moveTo(0f, 38f * y)
            cubicTo(8f * x, 29f * y, 3f * x, 12f * y, 11f * x, 6f * y)
            cubicTo(20f * x, 0f, 29f * x, 8f * y, 38f * x, 0f)
            close()
        }
        val lip = Path().apply {
            moveTo(1.5f * x, 38f * y)
            cubicTo(10f * x, 29f * y, 5f * x, 12f * y, 13f * x, 7f * y)
            cubicTo(21f * x, 2f * y, 30f * x, 8f * y, 38f * x, 1.5f * y)
        }
        val face = Brush.linearGradient(
            0f to Color(0xFFF6EAFF),
            0.24f to Color(0xFFDFC8FF),
            0.48f to Color(0xFFB18BDD),
            0.72f to Color(0xFF8057B8),
            1f to Color(0xFF482377),
            start = Offset.Zero,
            end = Offset(size.width, size.height),
        )
        val shade = Brush.horizontalGradient(listOf(Color(0x99251038), Color.Transparent))
        val stroke = Stroke(width = (0.7f * x).coerceAtLeast(0.45.dp.toPx()), cap = StrokeCap.Round)
        onDrawBehind {
            drawPath(shadow, shade)
            drawPath(fold, face)
            drawPath(lip, Color(0xB3F6E7FF), style = stroke)
        }
    })
}

@Composable
internal fun PaperArrowStack(modifier: Modifier = Modifier) {
    val shape = remember { RoundedCornerShape(topStart = 17.dp, topEnd = 17.dp, bottomEnd = 5.dp, bottomStart = 17.dp) }
    val backColors = remember { listOf(Color(0xFFC0A3ED), Color(0xFF9875D3)) }
    val frontColors = remember { listOf(Color(0xFFF0E6FC), Color(0xFFDDD0EF)) }
    Box(modifier, contentAlignment = Alignment.Center) {
        PaperSurface(
            shape = shape,
            modifier = Modifier.fillMaxSize(0.78f).offset(x = 5.dp, y = (-6).dp).rotate(13f),
            colors = backColors,
            elevation = 3.dp,
        ) {}
        PaperSurface(
            shape = shape,
            modifier = Modifier.fillMaxSize(0.78f).rotate(-11f),
            colors = frontColors,
            elevation = 6.dp,
        ) {}
        Box(Modifier.fillMaxSize().drawWithCache {
            val unit = size.minDimension * 0.4f
            val left = (size.width - unit) / 2
            val top = (size.height - unit) / 2
            val arrow = Path().apply {
                moveTo(left + unit * 0.18f, top + unit * 0.79f)
                lineTo(left + unit * 0.79f, top + unit * 0.2f)
                moveTo(left + unit * 0.3f, top + unit * 0.15f)
                lineTo(left + unit * 0.79f, top + unit * 0.2f)
                lineTo(left + unit * 0.74f, top + unit * 0.7f)
            }
            val stroke = Stroke(width = unit * 0.09f, cap = StrokeCap.Round, join = StrokeJoin.Round)
            onDrawBehind { drawPath(arrow, Color(0xFF6240D6), style = stroke) }
        })
    }
}
