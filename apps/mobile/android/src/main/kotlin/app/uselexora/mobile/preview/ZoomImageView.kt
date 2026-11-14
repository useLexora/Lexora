package app.uselexora.mobile.preview

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Matrix
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.widget.ImageView

class ZoomImageView(context: Context) : ImageView(context) {
    private var zoom = 1f
    private var offsetX = 0f
    private var offsetY = 0f
    private val transform = Matrix()
    private val scale = ScaleGestureDetector(context, object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
        override fun onScale(detector: ScaleGestureDetector): Boolean {
            val old = zoom
            zoom = (zoom * detector.scaleFactor).coerceIn(1f, 4f)
            offsetX = (offsetX - detector.focusX + width / 2f) * (zoom / old) + detector.focusX - width / 2f
            offsetY = (offsetY - detector.focusY + height / 2f) * (zoom / old) + detector.focusY - height / 2f
            updateTransform(); return true
        }
    })
    private val gestures = GestureDetector(context, object : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(event: MotionEvent) = true
        override fun onSingleTapUp(event: MotionEvent): Boolean { performClick(); return true }
        override fun onDoubleTap(event: MotionEvent): Boolean { zoom = if (zoom > 1f) 1f else 2f; offsetX = 0f; offsetY = 0f; updateTransform(); return true }
        override fun onScroll(first: MotionEvent?, current: MotionEvent, dx: Float, dy: Float): Boolean {
            if (!scale.isInProgress) { offsetX -= dx; offsetY -= dy; updateTransform() }; return true
        }
    })
    init { scaleType = ScaleType.MATRIX; isFocusable = true; isClickable = true }
    fun display(bitmap: Bitmap?) { setImageBitmap(bitmap); zoom = 1f; offsetX = 0f; offsetY = 0f; updateTransform() }
    fun zoomBy(factor: Float) { zoom = (zoom * factor).coerceIn(1f, 4f); updateTransform() }
    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) { super.onSizeChanged(w, h, oldw, oldh); updateTransform() }
    override fun onTouchEvent(event: MotionEvent): Boolean { scale.onTouchEvent(event); gestures.onTouchEvent(event); return true }
    override fun performClick(): Boolean { super.performClick(); return true }
    private fun updateTransform() {
        val image = drawable ?: return
        if (width == 0 || height == 0) return
        val fit = minOf(width.toFloat() / image.intrinsicWidth, height.toFloat() / image.intrinsicHeight)
        val scale = fit * zoom
        val imageWidth = image.intrinsicWidth * scale; val imageHeight = image.intrinsicHeight * scale
        val xLimit = maxOf(0f, (imageWidth - width) / 2f); val yLimit = maxOf(0f, (imageHeight - height) / 2f)
        offsetX = offsetX.coerceIn(-xLimit, xLimit); offsetY = offsetY.coerceIn(-yLimit, yLimit)
        transform.setScale(scale, scale)
        transform.postTranslate((width - imageWidth) / 2f + offsetX, (height - imageHeight) / 2f + offsetY)
        imageMatrix = transform
    }
}
