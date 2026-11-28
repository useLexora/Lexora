import { setCustomComponents, setMermaidLoader } from 'markstream-vue'
import DesktopMarkdownImage from './DesktopMarkdownImage.vue'
import DesktopMermaidBlock from './DesktopMermaidBlock.vue'
import { loadDesktopMermaid } from './mermaidLoader'
import { safeMarkdownHtmlComponents } from './safeMarkdownRenderers'

export const markdownCustomId = 'lexora-markdown'

setCustomComponents(markdownCustomId, {
  image: DesktopMarkdownImage,
  mermaid: DesktopMermaidBlock,
  ...safeMarkdownHtmlComponents,
})
setMermaidLoader(loadDesktopMermaid)
