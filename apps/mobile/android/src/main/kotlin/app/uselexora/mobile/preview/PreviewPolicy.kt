package app.uselexora.mobile.preview

import java.io.File
import java.util.Locale

enum class PreviewKind { TEXT, IMAGE, PDF }

object PreviewPolicy {
    const val MAX_FILE_BYTES = 64L * 1024 * 1024
    const val MAX_TEXT_CHARS = 65536
    const val MAX_PIXELS = 1048576
    const val MAX_EDGE = 1600
    private val activeExtensions = setOf("html", "htm", "xhtml", "svg", "svgz", "mhtml")
    private val textTypes = setOf("text/plain", "text/markdown", "text/csv", "text/tab-separated-values", "text/yaml", "application/json", "application/x-ndjson", "application/yaml")
    private val imageTypes = setOf("image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp")
    fun kind(name: String, mime: String): PreviewKind? {
        if (name.substringAfterLast('.', "").lowercase(Locale.ROOT) in activeExtensions) return null
        return when (mime.substringBefore(';').trim().lowercase(Locale.ROOT)) {
            in textTypes -> PreviewKind.TEXT
            in imageTypes -> PreviewKind.IMAGE
            "application/pdf" -> PreviewKind.PDF
            else -> null
        }
    }
    fun exportedFile(directory: File, path: String): File {
        val file = File(path).canonicalFile
        require(file.parentFile == directory.canonicalFile && file.isFile && file.length() in 0..MAX_FILE_BYTES)
        return file
    }
    fun dimensions(width: Int, height: Int): Pair<Int, Int> {
        require(width > 0 && height > 0)
        val scale = minOf(1.0, MAX_EDGE.toDouble() / maxOf(width, height), kotlin.math.sqrt(MAX_PIXELS.toDouble() / width / height))
        return maxOf(1, (width * scale).toInt()) to maxOf(1, (height * scale).toInt())
    }
}
