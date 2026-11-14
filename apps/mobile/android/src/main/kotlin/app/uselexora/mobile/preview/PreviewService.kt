package app.uselexora.mobile.preview

import android.app.Service
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.media.ExifInterface
import android.graphics.pdf.PdfRenderer
import android.os.*
import java.io.InputStreamReader
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

class PreviewService : Service() {
    private lateinit var worker: HandlerThread
    private lateinit var messenger: Messenger
    override fun onCreate() {
        super.onCreate()
        check(Process.myUid() != applicationInfo.uid)
        worker = HandlerThread("file-preview").apply { start() }
        messenger = Messenger(Handler(worker.looper) { message -> render(message); true })
    }
    override fun onBind(intent: Intent) = messenger.binder
    override fun onUnbind(intent: Intent): Boolean {
        Process.killProcess(Process.myPid())
        return false
    }
    override fun onDestroy() { worker.quitSafely(); super.onDestroy() }
    @Suppress("DEPRECATION")
    private fun render(message: Message) {
        val input = message.data.getParcelable<ParcelFileDescriptor>("input")
        val output = message.data.getParcelable<ParcelFileDescriptor>("output")
        val result = Bundle().apply { putInt("uid", Process.myUid()); putInt("pages", 1) }
        try {
            require(message.what == 1 && input != null && output != null && input.statSize in 0..PreviewPolicy.MAX_FILE_BYTES)
            when (PreviewKind.valueOf(message.data.getString("kind") ?: "")) {
                PreviewKind.TEXT -> text(input, result)
                PreviewKind.IMAGE -> image(input).let { bitmap -> try { pixels(bitmap, output, result) } finally { bitmap.recycle() } }
                PreviewKind.PDF -> ParcelFileDescriptor.dup(input.fileDescriptor).use { descriptor ->
                    PdfRenderer(descriptor).use { pdf ->
                        val index = message.data.getInt("page")
                        require(index in 0 until pdf.pageCount)
                        result.putInt("pages", pdf.pageCount)
                        pdf.openPage(index).use { page ->
                            val (width, height) = PreviewPolicy.dimensions(page.width, page.height)
                            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
                            try { bitmap.eraseColor(Color.WHITE); page.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY); pixels(bitmap, output, result) }
                            finally { bitmap.recycle() }
                        }
                    }
                }
            }
            result.putString("status", "ready")
        } catch (_: SecurityException) { result.putString("status", "protected") }
        catch (_: Exception) { result.putString("status", "unavailable") }
        finally { runCatching { input?.close() }; runCatching { output?.close() } }
        runCatching { message.replyTo?.send(Message.obtain(null, 1, message.arg1, 0).apply { data = result }) }
    }
    private fun text(input: ParcelFileDescriptor, result: Bundle) {
        val decoder = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        InputStreamReader(ParcelFileDescriptor.AutoCloseInputStream(ParcelFileDescriptor.dup(input.fileDescriptor)), decoder).use { reader ->
            val chars = CharArray(PreviewPolicy.MAX_TEXT_CHARS + 1)
            var count = 0
            while (count < chars.size) { val read = reader.read(chars, count, chars.size - count); if (read < 0) break; count += read }
            var length = minOf(count, PreviewPolicy.MAX_TEXT_CHARS)
            if (length > 0 && Character.isHighSurrogate(chars[length - 1])) length--
            val text = String(chars, 0, length)
            require(text.none { it < ' ' && it !in "\n\r\t" })
            result.putString("text", text); result.putBoolean("truncated", count > length)
        }
    }
    private fun image(input: ParcelFileDescriptor): Bitmap {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFileDescriptor(input.fileDescriptor, null, bounds)
        require(bounds.outWidth > 0 && bounds.outHeight > 0 && bounds.outWidth.toLong() * bounds.outHeight <= 100_000_000L)
        var sample = 1
        while (bounds.outWidth.toLong() / sample * (bounds.outHeight.toLong() / sample) > PreviewPolicy.MAX_PIXELS || maxOf(bounds.outWidth, bounds.outHeight) / sample > PreviewPolicy.MAX_EDGE) sample *= 2
        val decoded = BitmapFactory.decodeFileDescriptor(input.fileDescriptor, null, BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 }) ?: error("Unsupported image")
        val orientation = runCatching {
            ParcelFileDescriptor.AutoCloseInputStream(ParcelFileDescriptor.dup(input.fileDescriptor)).use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
        }.getOrDefault(ExifInterface.ORIENTATION_NORMAL)
        val matrix = Matrix().apply {
            when (orientation) {
                2 -> setScale(-1f, 1f)
                3 -> setRotate(180f)
                4 -> { setRotate(180f); postScale(-1f, 1f) }
                5 -> { setRotate(90f); postScale(-1f, 1f) }
                6 -> setRotate(90f)
                7 -> { setRotate(-90f); postScale(-1f, 1f) }
                8 -> setRotate(-90f)
            }
        }
        var oriented: Bitmap? = null
        try {
            oriented = Bitmap.createBitmap(decoded, 0, 0, decoded.width, decoded.height, matrix, true)
            val (width, height) = PreviewPolicy.dimensions(oriented.width, oriented.height)
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            try { Canvas(bitmap).drawBitmap(oriented, null, android.graphics.Rect(0, 0, width, height), null) }
            catch (failure: Throwable) { bitmap.recycle(); throw failure }
            return bitmap
        } finally { if (oriented !== decoded) oriented?.recycle(); decoded.recycle() }
    }
    private fun pixels(bitmap: Bitmap, output: ParcelFileDescriptor, result: Bundle) {
        require(bitmap.width.toLong() * bitmap.height <= PreviewPolicy.MAX_PIXELS)
        val buffer = ByteBuffer.allocate(bitmap.byteCount)
        bitmap.copyPixelsToBuffer(buffer); buffer.flip()
        ParcelFileDescriptor.AutoCloseOutputStream(ParcelFileDescriptor.dup(output.fileDescriptor)).use { it.write(buffer.array()) }
        result.putInt("width", bitmap.width); result.putInt("height", bitmap.height)
    }
}
