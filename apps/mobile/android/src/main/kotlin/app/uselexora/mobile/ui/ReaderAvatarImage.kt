package app.uselexora.mobile.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream

internal class ReaderAvatarImage(val url: String, private val png: ByteArray) {
    fun response() = WebResourceResponse("image/png", null, 200, "OK", mapOf("Cache-Control" to "no-store"), ByteArrayInputStream(png))

    companion object {
        fun decode(url: String, bytes: ByteArray): ReaderAvatarImage? {
            val options = BitmapFactory.Options().apply { inJustDecodeBounds = true; inSampleSize = 1 }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
            if (options.outWidth <= 0 || options.outHeight <= 0 || options.outWidth.toLong() * options.outHeight > 25_000_000) return null
            val side = maxOf(options.outWidth, options.outHeight)
            while (side > 256 * options.inSampleSize) options.inSampleSize *= 2
            options.inJustDecodeBounds = false
            val bitmap = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: return null
            return try {
                val output = ByteArrayOutputStream()
                if (bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)) ReaderAvatarImage(url, output.toByteArray()) else null
            } finally { bitmap.recycle() }
        }
    }
}
