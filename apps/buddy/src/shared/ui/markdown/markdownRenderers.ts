import { setCustomComponents, setMermaidLoader } from 'markstream-vue'
import DesktopMermaidBlock from './DesktopMermaidBlock.vue'
import { loadDesktopMermaid } from './mermaidLoader'

export const markdownCustomId = 'lexora-markdown'

setCustomComponents(markdownCustomId, { mermaid: DesktopMermaidBlock })
setMermaidLoader(loadDesktopMermaid)
