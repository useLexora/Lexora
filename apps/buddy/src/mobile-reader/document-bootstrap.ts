import { setKatexLoader, VueRendererMarkdown } from 'markstream-vue'
import { NMessageProvider } from 'naive-ui'
import { createApp, h } from 'vue'
import DocumentPreview from './DocumentPreview.vue'
import { markdownStrings } from './markdownStrings'
import 'virtual:uno.css'
import './reader.css'

setKatexLoader(() => import('katex'))
createApp({ render: () => h(NMessageProvider, null, { default: () => h(DocumentPreview) }) }).use(VueRendererMarkdown, { defaultI18nMap: markdownStrings }).mount('#app')
