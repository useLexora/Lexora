import { setKatexLoader, VueRendererMarkdown } from 'markstream-vue'
import { NMessageProvider } from 'naive-ui'
import { createApp, h } from 'vue'
import { markdownStrings } from './markdownStrings'
import MobileReader from './MobileReader.vue'
import 'virtual:uno.css'
import './reader.css'

setKatexLoader(() => import('katex'))
createApp({ render: () => h(NMessageProvider, null, { default: () => h(MobileReader) }) }).use(VueRendererMarkdown, { defaultI18nMap: markdownStrings }).mount('#app')
