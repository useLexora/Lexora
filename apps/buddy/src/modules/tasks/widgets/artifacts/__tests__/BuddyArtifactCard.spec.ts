// @vitest-environment jsdom
import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import { NMessageProvider } from 'naive-ui'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick } from 'vue'
import { useProvideArtifactActions } from '../artifactActionsContext'
import BuddyArtifactCard from '../BuddyArtifactCard.vue'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))
const artifact: LocalArtifact = {
  artifactId: 'artifact',
  conversationId: 'conversation',
  runId: 'run',
  sourceToolCallId: 'tool',
  kind: 'file',
  mimeType: 'text/plain',
  name: 'report.txt',
  path: '/workspace/report.txt',
  sizeBytes: 12,
  previewUrl: null,
  sourceArtifactId: null,
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
}
function mountCard() {
  const root = document.createElement('div')
  document.body.append(root)
  const opened: string[] = []
  let revealFails = true
  const content = defineComponent({
    setup() {
      useProvideArtifactActions({
        language: () => 'zh-CN',
        task: () => null,
        resources: { locateFile: () => {} },
        revealFile: async () => {
          if (revealFails)
            throw new Error('private path')
        },
        writeClipboardText: async () => {},
      })
      return () => h(BuddyArtifactCard, { artifact, language: 'zh-CN', onOpenArtifact: id => opened.push(id) })
    },
  })
  const app = createApp(() => h(NMessageProvider, {}, { default: () => h(content) }))
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  return { root, opened, allowReveal: () => revealFails = false }
}
const menuItems = () => [...document.querySelectorAll<HTMLElement>('.n-dropdown-option-body')].filter(item => !item.closest('[style*="display: none"]'))
async function settle() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

describe('artifact card controls', () => {
  it('opens the artifact menu by right-click and Shift+F10 without opening the artifact', async () => {
    const f = mountCard()
    const card = f.root.querySelector<HTMLElement>('.buddy-artifact-collection__item')!
    card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
    await settle()
    expect(menuItems().map(item => item.textContent)).toContain('复制路径')
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await expect.poll(() => menuItems()).toHaveLength(0)
    card.dispatchEvent(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true, bubbles: true, cancelable: true }))
    await settle()
    expect(menuItems().map(item => item.textContent)).toContain('复制路径')
    expect(f.opened).toEqual([])
  })

  it('reports a failed folder reveal once without leaking the error or opening the artifact', async () => {
    const f = mountCard()
    f.root.querySelector<HTMLButtonElement>('.buddy-artifact-collection__more')!.click()
    await settle()
    menuItems()[2]!.click()
    await settle()
    expect(document.querySelectorAll('.n-message')).toHaveLength(1)
    expect(document.querySelector('.n-message')?.textContent).toContain('无法打开产物所在文件夹')
    expect(document.body.textContent).not.toContain('private path')
    expect(f.opened).toEqual([])
    f.allowReveal()
    f.root.querySelector<HTMLButtonElement>('.buddy-artifact-collection__more')!.click()
    await settle()
    menuItems()[2]!.click()
    await settle()
    expect(document.querySelectorAll('.n-message')).toHaveLength(1)
  })
})
