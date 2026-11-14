package app.uselexora.mobile.ui

import app.uselexora.mobile.i18n.mobileText
import app.uselexora.mobile.R
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Check
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.UriHandler
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.uselexora.mobile.protocol.MobileMessagePresentation
import com.mikepenz.markdown.compose.LocalMarkdownComponents
import com.mikepenz.markdown.compose.MarkdownElement
import com.mikepenz.markdown.compose.components.markdownComponents
import com.mikepenz.markdown.compose.elements.MarkdownTable
import com.mikepenz.markdown.compose.elements.MarkdownTableHeader
import com.mikepenz.markdown.compose.elements.MarkdownTableRow
import com.mikepenz.markdown.m3.Markdown
import com.mikepenz.markdown.m3.markdownColor
import com.mikepenz.markdown.m3.markdownTypography
import com.mikepenz.markdown.model.NoOpImageTransformerImpl
import com.mikepenz.markdown.model.State
import com.mikepenz.markdown.model.markdownAnimations
import com.mikepenz.markdown.model.markdownAnnotator
import com.mikepenz.markdown.model.markdownDimens
import com.mikepenz.markdown.model.markdownPadding
import com.mikepenz.markdown.model.parseMarkdownFlow
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import org.intellij.markdown.MarkdownElementTypes
import org.intellij.markdown.MarkdownTokenTypes
import org.intellij.markdown.ast.getTextInNode

private val markdownParsingSlots = Semaphore(2)

@Composable
internal fun MobileMarkdown(
    text: String,
    cache: MobileMarkdownCache,
    modifier: Modifier = Modifier,
    onOpenFile: () -> Unit,
    onRendered: () -> Unit,
) {
    val latestText by rememberUpdatedState(text)
    val renderedCallback by rememberUpdatedState(onRendered)
    var parsed by remember { mutableStateOf(cache[text]) }
    var failedText by remember { mutableStateOf<String?>(null) }
    var linkNotice by remember { mutableStateOf<String?>(null) }
    val external = LocalUriHandler.current
    val links = remember(external) {
        object : UriHandler {
            override fun openUri(uri: String) {
                val safe = MobileReadingPolicy.webLink(uri)
                if (safe == null) linkNotice = mobileText(R.string.mobile_only_http_and_https_web_links_can_be_opened)
                else try { external.openUri(safe); linkNotice = null }
                catch (_: RuntimeException) { linkNotice = mobileText(R.string.mobile_could_not_open_the_link_copy_the_address_from) }
            }
        }
    }
    LaunchedEffect(cache) {
        snapshotFlow { latestText }.conflate().collect {
            delay(70)
            val content = latestText
            if (parsed?.content == content) return@collect
            if (!MobileReadingPolicy.canParse(content)) {
                failedText = content
                renderedCallback()
                return@collect
            }
            val result = try {
                cache[content] ?: markdownParsingSlots.withPermit {
                    withContext(Dispatchers.Default) {
                        (parseMarkdownFlow(content).first { it !is State.Loading } as? State.Success)
                            ?.takeIf { MobileReadingPolicy.acceptableTree(it.node) }
                    }
                }
            } catch (error: CancellationException) { throw error }
            catch (_: Exception) { null }
            ensureActive()
            if (result != null) {
                cache.put(result)
                if (latestText.startsWith(content)) { parsed = result; failedText = null; renderedCallback() }
            } else if (latestText == content) { failedText = content; renderedCallback() }
        }
    }
    val retained = parsed?.takeIf { text.startsWith(it.content) && failedText != text }
    Column(modifier, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (retained == null) {
            Text(text, style = MaterialTheme.typography.bodyLarge)
            if (failedText == text) Text(if (MobileReadingPolicy.canParse(text)) mobileText(R.string.mobile_formatting_unavailable_the_original_text_is_retained) else mobileText(R.string.mobile_long_content_is_shown_as_plain_text_open_the), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else CompositionLocalProvider(LocalUriHandler provides links) {
            Markdown(
                state = retained,
                modifier = Modifier.fillMaxWidth(),
                colors = markdownColor(text = MaterialTheme.colorScheme.onSurface, codeBackground = MaterialTheme.colorScheme.surfaceContainerLow, tableBackground = MaterialTheme.colorScheme.surfaceContainerLow),
                typography = markdownTypography(
                    h1 = MaterialTheme.typography.headlineSmall, h2 = MaterialTheme.typography.titleLarge,
                    h3 = MaterialTheme.typography.titleMedium, h4 = MaterialTheme.typography.titleMedium,
                    h5 = MaterialTheme.typography.titleSmall, h6 = MaterialTheme.typography.titleSmall,
                    table = MaterialTheme.typography.bodyMedium,
                ),
                padding = markdownPadding(block = 7.dp, listItemTop = 3.dp, listItemBottom = 3.dp, listIndent = 14.dp),
                dimens = markdownDimens(tableCellWidth = 152.dp, tableCellPadding = 10.dp),
                animations = markdownAnimations(animateTextSize = { this }),
                imageTransformer = remember { NoOpImageTransformerImpl() },
                annotator = remember {
                    markdownAnnotator { content, node ->
                        when (node.type) {
                            MarkdownElementTypes.IMAGE -> { append(mobileText(R.string.mobile_image, MobileReadingPolicy.imageLabel(content, node))); true }
                            MarkdownTokenTypes.HTML_TAG -> { append(node.getTextInNode(content)); true }
                            else -> false
                        }
                    }
                },
                components = markdownComponents(
                    codeFence = { MobileCode(MobileReadingPolicy.code(it.content, it.node), onOpenFile) },
                    codeBlock = { MobileCode(MobileReadingPolicy.code(it.content, it.node), onOpenFile) },
                    image = { Text(mobileText(R.string.mobile_image, MobileReadingPolicy.imageLabel(it.content, it.node)), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) },
                    table = {
                        MarkdownTable(it.content, it.node, it.typography.table,
                            headerBlock = { content, node, width, style -> MarkdownTableHeader(content, node, width, style, maxLines = Int.MAX_VALUE, overflow = TextOverflow.Clip) },
                            rowBlock = { content, node, width, style -> MarkdownTableRow(content, node, width, style, maxLines = Int.MAX_VALUE, overflow = TextOverflow.Clip) },
                        )
                    },
                    custom = { type, model ->
                        if (type == MarkdownElementTypes.HTML_BLOCK) Text(model.node.getTextInNode(model.content).toString(), style = MaterialTheme.typography.bodyMedium)
                        else model.node.children.forEach { MarkdownElement(it, LocalMarkdownComponents.current, model.content) }
                    },
                ),
            )
        }
        linkNotice?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun MobileCode(code: MobileCodeBlock, onOpenFile: () -> Unit) {
    Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, shape = MaterialTheme.shapes.small) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(code.language?.take(48) ?: mobileText(R.string.mobile_code), Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                MessageCopyButton(code.text, onOpenFile, mobileText(R.string.mobile_copy_code))
            }
            val body: @Composable () -> Unit = {
                Text(code.text, Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(bottom = 6.dp), style = MaterialTheme.typography.bodyMedium, fontFamily = FontFamily.Monospace, softWrap = false)
            }
            if (MobileMessagePresentation.canCopy(code.text)) SelectionContainer { body() } else body()
        }
    }
}

@Composable
internal fun MessageCopyButton(text: String, onOpenFile: () -> Unit, label: String = mobileText(R.string.mobile_copy_content)) {
    val clipboard = LocalClipboardManager.current
    var copied by remember(text) { mutableStateOf(false) }
    if (!MobileMessagePresentation.canCopy(text)) {
        TextButton(onClick = onOpenFile, contentPadding = PaddingValues(0.dp)) { Text(mobileText(R.string.mobile_open_content_file)) }
        return
    }
    IconButton(onClick = {
        try { clipboard.setText(AnnotatedString(text)); copied = true }
        catch (_: RuntimeException) { onOpenFile() }
    }, modifier = Modifier.size(40.dp)) {
        Icon(if (copied) Icons.Outlined.Check else Icons.Outlined.ContentCopy, contentDescription = if (copied) mobileText(R.string.copied) else label, modifier = Modifier.size(17.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
