package app.uselexora.mobile.preview

import android.content.*
import android.graphics.Bitmap
import android.os.*
import java.io.File
import java.io.FileInputStream
import java.nio.ByteBuffer
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

data class PreviewPage(val bitmap: Bitmap?, val text: String?, val truncated: Boolean, val pageCount: Int, val rendererUid: Int)
class PreviewFailure(val reason: String) : Exception(reason)

class PreviewClient(private val context: Context) : AutoCloseable {
    private val ready = CompletableFuture<Messenger>()
    private val pending = ConcurrentHashMap<Int, CompletableFuture<Bundle>>()
    private val sequence = AtomicInteger()
    private val closed = AtomicBoolean()
    private val rendering = AtomicBoolean()
    private var bound = false
    private val reply = Messenger(Handler(Looper.getMainLooper()) { message -> pending.remove(message.arg1)?.complete(message.data); true })
    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) { ready.complete(Messenger(binder)) }
        override fun onServiceDisconnected(name: ComponentName) { fail() }
        override fun onNullBinding(name: ComponentName) { fail() }
        override fun onBindingDied(name: ComponentName) { fail() }
    }
    init {
        bound = context.bindService(Intent(context, PreviewService::class.java), connection, Context.BIND_AUTO_CREATE)
        if (!bound) fail()
    }
    fun render(file: File, kind: PreviewKind, page: Int = 0): PreviewPage {
        if (closed.get() || !rendering.compareAndSet(false, true)) throw PreviewFailure("unavailable")
        var output: File? = null
        val id = sequence.incrementAndGet()
        val response = CompletableFuture<Bundle>()
        try {
            val service = ready.get(10, TimeUnit.SECONDS)
            if (closed.get()) throw PreviewFailure("unavailable")
            output = File.createTempFile("preview-", ".pixels", context.cacheDir)
            pending[id] = response
            ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { input ->
                ParcelFileDescriptor.open(output, ParcelFileDescriptor.MODE_WRITE_ONLY or ParcelFileDescriptor.MODE_TRUNCATE).use { target ->
                    service.send(Message.obtain(null, 1, id, 0).apply {
                        replyTo = reply
                        data = Bundle().apply { putParcelable("input", input); putParcelable("output", target); putString("kind", kind.name); putInt("page", page) }
                    })
                }
            }
            val result = response.get(20, TimeUnit.SECONDS)
            if (closed.get() || result.getInt("uid") == Process.myUid()) throw PreviewFailure("unavailable")
            if (result.getString("status") != "ready") throw PreviewFailure(result.getString("status") ?: "unavailable")
            val pages = result.getInt("pages")
            require(pages > 0 && page in 0 until pages)
            val text = result.getString("text")
            if (kind == PreviewKind.TEXT) {
                require(text != null && text.length <= PreviewPolicy.MAX_TEXT_CHARS)
                return PreviewPage(null, text, result.getBoolean("truncated"), pages, result.getInt("uid"))
            }
            val width = result.getInt("width"); val height = result.getInt("height")
            require(width in 1..PreviewPolicy.MAX_EDGE && height in 1..PreviewPolicy.MAX_EDGE && width.toLong() * height <= PreviewPolicy.MAX_PIXELS)
            val bytes = width * height * 4
            require(output.length() == bytes.toLong())
            val buffer = ByteBuffer.allocate(bytes)
            FileInputStream(output).channel.use { channel -> while (buffer.hasRemaining()) if (channel.read(buffer) < 0) error("Incomplete preview") }
            buffer.flip()
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            try { bitmap.copyPixelsFromBuffer(buffer) } catch (failure: Throwable) { bitmap.recycle(); throw failure }
            return PreviewPage(bitmap, null, false, pages, result.getInt("uid"))
        } catch (error: java.util.concurrent.TimeoutException) { close(); throw PreviewFailure("timeout") }
        finally { pending.remove(id); output?.delete(); rendering.set(false) }
    }
    private fun fail() {
        val failure = PreviewFailure("unavailable")
        ready.completeExceptionally(failure)
        pending.values.forEach { it.completeExceptionally(failure) }
        pending.clear()
    }
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        fail()
        if (bound) { context.unbindService(connection); bound = false }
    }
}
