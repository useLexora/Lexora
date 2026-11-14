package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import com.mikepenz.markdown.model.State
import org.intellij.markdown.MarkdownElementTypes
import org.intellij.markdown.MarkdownTokenTypes
import org.intellij.markdown.ast.ASTNode
import org.intellij.markdown.ast.getTextInNode
import org.json.JSONObject
import java.net.URI
import java.util.Locale

internal data class MobileCodeBlock(val text: String, val language: String?)
internal data class MobileResourceLabel(val name: String, val type: String, val size: String, val status: String?, val available: Boolean)

internal object MobileReadingPolicy {
    const val MAX_MARKDOWN_CHARS = 65_536
    const val MAX_MARKDOWN_LINES = 1_024

    fun canParse(text: String): Boolean = text.length <= MAX_MARKDOWN_CHARS && text.count { it == '\n' } < MAX_MARKDOWN_LINES

    fun acceptableTree(root: ASTNode): Boolean {
        val pending = ArrayDeque<Pair<ASTNode, Int>>()
        pending.add(root to 0)
        var count = 0
        while (pending.isNotEmpty()) {
            val (node, depth) = pending.removeLast()
            if (++count > 12_000 || depth > 64) return false
            node.children.forEach { pending.add(it to depth + 1) }
        }
        return true
    }

    fun webLink(value: String): String? = runCatching {
        val uri = URI(value)
        if (uri.scheme?.lowercase(Locale.ROOT) !in setOf("http", "https") || uri.host.isNullOrBlank() || uri.rawUserInfo != null || uri.port !in -1..65535) null
        else uri.toASCIIString()
    }.getOrNull()

    fun code(content: String, node: ASTNode): MobileCodeBlock {
        val language = node.children.firstOrNull { it.type == MarkdownTokenTypes.FENCE_LANG }
            ?.getTextInNode(content)?.toString()?.trim()?.takeIf { it.isNotEmpty() }
        val text = if (node.type == MarkdownElementTypes.CODE_FENCE) {
            node.children.dropWhile { it.type != MarkdownTokenTypes.EOL }.drop(1)
                .takeWhile { it.type != MarkdownTokenTypes.CODE_FENCE_END }.joinToString("") { it.getTextInNode(content) }
        } else {
            node.getTextInNode(content).toString().lineSequence().joinToString("\n") { line ->
                when { line.startsWith("    ") -> line.drop(4); line.startsWith('\t') -> line.drop(1); else -> line }
            }
        }
        return MobileCodeBlock(text, language)
    }

    fun imageLabel(content: String, node: ASTNode): String {
        val pending = ArrayDeque<ASTNode>().apply { add(node) }
        while (pending.isNotEmpty()) {
            val child = pending.removeFirst()
            if (child.type == MarkdownElementTypes.LINK_TEXT) return child.getTextInNode(content).toString().removeSurrounding("[", "]").ifBlank { mobileText(R.string.mobile_image_2) }
            pending.addAll(child.children)
        }
        return mobileText(R.string.mobile_image_2)
    }

    fun resource(value: JSONObject): MobileResourceLabel {
        val mime = value.optString("mimeType").substringBefore(';').trim().lowercase(Locale.ROOT)
        val type = when {
            mime == "application/pdf" -> mobileText(R.string.mobile_pdf_document)
            mime.startsWith("image/") -> mobileText(R.string.mobile_image_2)
            mime.startsWith("audio/") -> mobileText(R.string.mobile_audio)
            mime.startsWith("video/") -> mobileText(R.string.mobile_video)
            mime == "application/json" -> mobileText(R.string.mobile_json_file)
            mime == "text/markdown" -> mobileText(R.string.mobile_markdown_document)
            mime.startsWith("text/") -> mobileText(R.string.mobile_text_file)
            else -> mobileText(R.string.file_label)
        }
        val availability = value.optString("availability")
        val bytes = value.optString("sizeBytes").toLongOrNull()?.takeIf { it >= 0 }
        val size = when {
            bytes == null || bytes == 0L && availability == "export_required" -> mobileText(R.string.mobile_size_pending)
            bytes < 1024 -> "$bytes B"
            bytes < 1024 * 1024 -> String.format(app.uselexora.mobile.i18n.MobileStrings.locale, "%.1f KB", bytes / 1024.0)
            else -> String.format(app.uselexora.mobile.i18n.MobileStrings.locale, "%.1f MB", bytes / (1024.0 * 1024.0))
        }
        return MobileResourceLabel(
            value.optString("name").ifBlank { mobileText(R.string.mobile_attachment) }, type, size,
            when (availability) { "unavailable" -> mobileText(R.string.mobile_temporarily_unavailable); "export_required" -> mobileText(R.string.mobile_file_prepared_when_opened); else -> null },
            availability == "ready" || availability == "export_required",
        )
    }
}

internal class MobileMarkdownCache {
    private val entries = LinkedHashMap<String, State.Success>(16, 0.75f, true)
    operator fun get(text: String): State.Success? = entries[text]
    fun put(value: State.Success) {
        entries[value.content] = value
        while (entries.size > 16 || entries.keys.sumOf { it.length } > 262_144) entries.remove(entries.keys.first())
    }
}
