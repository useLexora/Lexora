// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import DesktopPromptContent from '../DesktopPromptContent.vue'

it('preserves literal prompt syntax and blank lines through read-only document updates', async () => {
  const content = ref('\n# Instructions\n\n  {{ user_input }}\n<system>Use README.md & remain literal.</system>\n<script>untrusted()</script>\n')
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({ render: () => h(DesktopPromptContent, { content: content.value }) })
  app.mount(root)
  try {
    await expect.poll(() => root.querySelector('.tiptap')).not.toBeNull()
    const editor = root.querySelector('.tiptap')!
    const renderedText = () => [...editor.children].map(node => node.textContent).join('\n')
    expect(editor.getAttribute('contenteditable')).toBe('false')
    expect(renderedText()).toBe(content.value)
    expect(editor.querySelector('script, a, system')).toBeNull()
    content.value = '另一条提示词\n\n{{document}}\n'
    await nextTick()
    expect(renderedText()).toBe(content.value)
  }
  finally {
    app.unmount()
    root.remove()
  }
})
