package app.uselexora.mobile.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import app.uselexora.mobile.R

internal object PaintedShape : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val edge = with(density) { 1.5.dp.toPx() }.coerceAtMost(size.minDimension / 12)
        val radius = with(density) { 10.dp.toPx() }.coerceAtMost(size.minDimension / 3)
        val w = size.width
        val h = size.height
        return Outline.Generic(Path().apply {
            moveTo(radius, edge)
            cubicTo(w * 0.35f, 0f, w * 0.7f, edge * 2, w - radius, edge)
            quadraticBezierTo(w - edge, 0f, w - edge, radius)
            lineTo(w, h - radius)
            quadraticBezierTo(w, h - edge, w - radius, h - edge)
            cubicTo(w * 0.65f, h, w * 0.3f, h - edge * 2, radius, h)
            quadraticBezierTo(edge, h, edge, h - radius)
            lineTo(0f, radius)
            quadraticBezierTo(0f, edge * 2, radius, edge)
            close()
        })
    }
}

@Composable
internal fun BrushMark(modifier: Modifier, color: Color = MaterialTheme.colorScheme.secondaryContainer) {
    Canvas(modifier) {
        val w = size.width
        val h = size.height
        drawPath(Path().apply {
            moveTo(0f, h * 0.28f)
            cubicTo(w * 0.3f, h * 0.08f, w * 0.7f, h * 0.32f, w * 0.98f, 0f)
            lineTo(w, h * 0.68f)
            cubicTo(w * 0.7f, h, w * 0.3f, h * 0.8f, w * 0.02f, h)
            close()
        }, color)
    }
}

@Composable
internal fun PaintedCompanion(modifier: Modifier = Modifier.width(160.dp)) {
    Image(
        painter = painterResource(R.drawable.workbench_companion), contentDescription = null,
        contentScale = ContentScale.Fit, modifier = modifier.aspectRatio(1.5f),
    )
}
