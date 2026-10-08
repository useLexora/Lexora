// @vitest-environment jsdom
import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import { selectionArtifact } from '@buddy-shared/artifacts/__tests__/artifactSelectionFixture'
import { createBuddyUserContent } from '@buddy-shared/conversation/buddyUserContent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, provide, shallowRef } from 'vue'
import { WorkbenchSelectionReferences, workbenchSelectionReferencesKey } from '@/shared/ui/selection/workbenchSelectionReferences'
import DesktopArtifactContextSurface from '../DesktopArtifactContextSurface.vue'

const feedback = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn(), info: vi.fn() }))
vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    useMessage: () => feedback,
    NSpin: defineComponent({ setup: () => () => h('span', 'Loading') }),
    NDropdown: defineComponent({ props: ['show', 'options', 'menuProps', 'renderLabel'], emits: ['select'], setup: (props, { emit }) => () => props.show
      ? h('div', props.menuProps(), props.options.filter((option: { type?: string }) => option.type !== 'divider').map((option: { key: string }) => h('button', { onClick: () => emit('select', option.key) }, props.renderLabel(option))))
      : null }),
  }
})
vi.mock('../DesktopArtifactToolbar.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ setup: () => () => h('header', 'Artifact toolbar') }) }
})
vi.mock('@/shared/ui/media/BuddyImagePreview.vue', async () => {
  const { defineComponent } = await import('vue')
  return { default: defineComponent({ setup: () => () => null }) }
})
vi.mock('@/shared/ui/markdown/DesktopMarkdownContent.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ props: ['content'], setup: props => () => h('p', props.content) }) }
})
vi.mock('@/shared/ui/files/DesktopMonacoFile.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ props: ['text'], setup: props => () => h('pre', props.text) }) }
})
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  window.getSelection()?.removeAllRanges()
})
async function fixture(initial: LocalArtifact = selectionArtifact, failure = false) {
  const root = document.createElement('div')
  document.body.append(root)
  const artifact = shallowRef(initial)
  const visible = shallowRef(true)
  const mode = shallowRef<'preview' | 'source'>('preview')
  const content = shallowRef(createBuddyUserContent('Keep latest input'))
  const read = vi.fn(async (artifactId: string) => {
    if (failure)
      throw new Error('Artifact unavailable')
    return { artifactId, language: 'markdown', text: '<script>Not executable</script> Frozen artifact excerpt.' }
  })
  const host = new WorkbenchSelectionReferences({
    targets: () => [{ id: 'task', identity: 'task:draft:epoch', scope: 'task:a', label: 'Task A', read: () => content.value, write: value => content.value = value }],
    source: () => visible.value ? { identity: JSON.stringify([artifact.value, mode.value]), owner: 'task:a' } : null,
    locate: async () => false,
  })
  const app = createApp(defineComponent({ setup() {
    provide(workbenchSelectionReferencesKey, host)
    return () => h(DesktopArtifactContextSurface, { artifact: artifact.value, tabId: `artifact:${artifact.value.artifactId}`, visible: visible.value, language: 'zh-CN', viewMode: mode.value, readArtifactText: read, writeClipboardText: async () => {} })
  } }))
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  await nextTick()
  return { root, artifact, visible, mode, content, read }
}
async function openMenu(root: HTMLElement) {
  await vi.waitFor(() => expect(root.querySelector('article p')).not.toBeNull())
  const paragraph = root.querySelector('article p')!
  const range = document.createRange()
  range.selectNode(paragraph)
  window.getSelection()!.removeAllRanges()
  window.getSelection()!.addRange(range)
  paragraph.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 30 }))
  await nextTick()
  const menu = root.querySelector<HTMLElement>('[role="menu"]')
  expect(menu).not.toBeNull()
  return menu!
}

describe('artifact selection references', () => {
  it('captures a safe Markdown excerpt and preserves the draft without attachments or comment input', async () => {
    const f = await fixture()
    const menu = await openMenu(f.root)
    expect(menu.textContent).toBe('引用到对话')
    menu.querySelector('button')!.click()
    await nextTick()
    const quote = f.content.value.resourceQuotes![0]!
    expect(quote.source).toMatchObject({ kind: 'artifact', artifactId: selectionArtifact.artifactId, conversationId: 'a', format: 'markdown', path: selectionArtifact.path })
    expect(quote.text).toContain('<script>Not executable</script>')
    expect(f.content.value.body).toEqual(createBuddyUserContent('Keep latest input').body)
    expect(f.content.value.panelResourceIds).toEqual([])
    expect(f.root.querySelector('script, input, textarea')).toBeNull()
    expect(f.read).toHaveBeenCalledTimes(1)
  })

  it.each(['version', 'mode', 'hidden'])('closes the quote menu after the artifact is %s', async (change) => {
    const f = await fixture()
    await openMenu(f.root)
    if (change === 'version')
      f.artifact.value = { ...selectionArtifact, updatedAt: '2026-10-03T00:00:01.000Z' }
    if (change === 'mode')
      f.mode.value = 'source'
    if (change === 'hidden')
      f.visible.value = false
    await nextTick()
    expect(f.root.querySelector('[role="menu"]')).toBeNull()
    expect(f.content.value.resourceQuotes).toBeUndefined()
  })

  it.each([
    { ...selectionArtifact, name: 'image.png', mimeType: 'image/png' },
    { ...selectionArtifact, name: 'report.pdf', mimeType: 'application/pdf' },
    { ...selectionArtifact, kind: 'directory' as const },
  ])('does not enable text quoting for a non-text artifact', async (artifact) => {
    const f = await fixture(artifact)
    expect(f.read).not.toHaveBeenCalled()
    expect(f.root.querySelector('article, [role="menu"]')).toBeNull()
  })

  it('does not expose quote actions when text loading fails', async () => {
    const f = await fixture(selectionArtifact, true)
    await vi.waitFor(() => expect(f.root.textContent).toContain('无法读取该文件预览'))
    expect(f.root.querySelector('article, [role="menu"]')).toBeNull()
  })
})
