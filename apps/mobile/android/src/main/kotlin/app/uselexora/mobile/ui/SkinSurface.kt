package app.uselexora.mobile.ui

import android.content.res.AssetManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import androidx.compose.foundation.clickable
import androidx.compose.foundation.indication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.ripple
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.remember
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipPath
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.SemanticsPropertyKey
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.roundToInt
import androidx.compose.ui.unit.dp
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.min
import kotlin.math.sin

internal val SkinImageReady = SemanticsPropertyKey<Boolean>("SkinImageReady")

@Composable
internal fun SkinSurface(
    style: SkinSurfaceStyle,
    modifier: Modifier = Modifier,
    onClick: (() -> Unit)? = null,
    content: @Composable BoxScope.() -> Unit = {},
) {
    val outline = remember(style.shape) { SkinOutline(style.shape) }
    val bitmap = skinBitmap(style.image)
    val interaction = remember { MutableInteractionSource() }
    val painted = modifier.semantics { if (style.image != null) this[SkinImageReady] = bitmap != null }.drawWithCache {
        val patches = bitmap?.let { skinImagePatches(it.width, it.height, size.width.roundToInt(), size.height.roundToInt(), style.image?.insets) }
        val outer = style.shape.path(size, density)
        val brush = style.fill.brush(size)
        val inset = style.insetBorder?.let { border ->
            val insetPx = border.inset.dp.toPx().coerceAtMost(min(size.width, size.height) / 3f)
            insetPx to style.shape.path(Size(size.width - insetPx * 2, size.height - insetPx * 2), density)
        }
        val layers = style.layers.map { layer ->
            val bounds = layer.bounds
            val layerSize = Size(size.width * bounds[2], size.height * bounds[3])
            Triple(layer, layer.shape.path(layerSize, density), layer.fill.brush(layerSize))
        }
        onDrawBehind {
            if (bitmap != null && patches != null) {
                for (patch in patches) drawImage(bitmap, srcOffset = IntOffset(patch.sx, patch.sy), srcSize = IntSize(patch.sw, patch.sh),
                    dstOffset = IntOffset(patch.dx, patch.dy), dstSize = IntSize(patch.dw, patch.dh), filterQuality = FilterQuality.Medium)
                return@onDrawBehind
            }
            style.shadow?.let { shadow ->
                translate(shadow.x.dp.toPx(), shadow.y.dp.toPx()) { drawPath(outer, Color(shadow.color)) }
            }
            clipPath(outer) {
                drawPath(outer, brush)
                layers.forEach { (layer, path, fill) ->
                    translate(size.width * layer.bounds[0], size.height * layer.bounds[1]) {
                        drawPath(path, fill, alpha = layer.opacity)
                        layer.border?.let { drawPath(path, Color(it.color), alpha = layer.opacity, style = Stroke(it.width.dp.toPx())) }
                    }
                }
                style.border?.let { drawPath(outer, Color(it.color), style = Stroke(it.width.dp.toPx() * 2)) }
                style.insetBorder?.let { border ->
                    inset?.let { (offset, path) ->
                        translate(offset, offset) { drawPath(path, Color(border.color), style = Stroke(border.width.dp.toPx())) }
                    }
                }
            }
        }
    }
    CompositionLocalProvider(LocalContentColor provides Color(style.foreground)) {
        Box(if (onClick == null) painted else painted.clickable(interactionSource = interaction, indication = null, role = Role.Button, onClick = onClick)) {
            if (onClick != null) Box(Modifier.matchParentSize().clip(outline).indication(interaction, ripple()))
            content()
        }
    }
}

private object SkinBitmapCache {
    private val cache = object : LruCache<String, Bitmap>(24 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.allocationByteCount
    }

    fun load(assets: AssetManager, path: String): Bitmap? {
        cache.get(path)?.let { return it }
        return try {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true; inScaled = false }
            assets.open(path).use { stream ->
                require(stream.available() <= 8 * 1024 * 1024)
                BitmapFactory.decodeStream(stream, null, bounds)
            }
            require(bounds.outWidth in 1..4096 && bounds.outHeight in 1..4096)
            require(bounds.outWidth.toLong() * bounds.outHeight <= 4_194_304L)
            assets.open(path).use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inScaled = false }) }
                ?.also { cache.put(path, it) }
        } catch (_: Exception) { null }
    }
}

@Composable
internal fun skinBitmap(image: SkinSurfaceImage?): ImageBitmap? {
    val assets = LocalContext.current.assets
    val bitmap by produceState<Bitmap?>(null, assets, image) {
        value = null
        value = if (image == null) null else withContext(Dispatchers.IO) {
            SkinBitmapCache.load(assets, image.path)?.takeIf { bitmap ->
                runCatching { skinImagePatches(bitmap.width, bitmap.height, 1, 1, image.insets) }.isSuccess
            }
        }
    }
    return remember(bitmap) { bitmap?.asImageBitmap() }
}

private class SkinOutline(private val specification: SkinShape) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline =
        Outline.Generic(specification.path(size, density.density))
}

private fun SkinShape.path(size: Size, density: Float): Path = Path().apply {
    val w = size.width
    val h = size.height
    when (type) {
        "rounded" -> {
            val radiusPx = min(radius * density, min(w, h) / 2)
            addRoundRect(RoundRect(Rect(Offset.Zero, size), CornerRadius(radiusPx)))
        }
        "cut" -> {
            val c = min(cut * density, min(w, h) / 3)
            moveTo(c, 0f); lineTo(w - c, 0f); lineTo(w, c); lineTo(w, h - c)
            lineTo(w - c, h); lineTo(c, h); lineTo(0f, h - c); lineTo(0f, c); close()
        }
        "path" -> commands.forEach { command ->
            val v = command.values
            when (command.op) {
                "M" -> moveTo(v[0] * w, v[1] * h)
                "L" -> lineTo(v[0] * w, v[1] * h)
                "C" -> cubicTo(v[0] * w, v[1] * h, v[2] * w, v[3] * h, v[4] * w, v[5] * h)
                "Q" -> quadraticTo(v[0] * w, v[1] * h, v[2] * w, v[3] * h)
                "Z" -> close()
            }
        }
    }
}

private fun SkinFill.brush(size: Size): Brush {
    if (colors.size == 1) return SolidColor(Color(colors.single()))
    val radians = Math.toRadians(angle.toDouble())
    val dx = cos(radians).toFloat()
    val dy = sin(radians).toFloat()
    val length = (abs(dx) * size.width + abs(dy) * size.height) / 2f
    val center = Offset(size.width / 2f, size.height / 2f)
    val vector = Offset(dx * length, dy * length)
    return Brush.linearGradient(colors.map(::Color), center - vector, center + vector)
}
