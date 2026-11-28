import { setCustomComponents } from 'markstream-vue'
import SafeMarkdownHtmlBlock from './SafeMarkdownHtmlBlock.vue'
import SafeMarkdownHtmlInline from './SafeMarkdownHtmlInline.vue'

export const safeMarkdownCustomId = 'lexora-safe-markdown'

export const safeMarkdownHtmlComponents = {
  html_block: SafeMarkdownHtmlBlock,
  html_inline: SafeMarkdownHtmlInline,
} as const

setCustomComponents(safeMarkdownCustomId, safeMarkdownHtmlComponents)
