// @vitest-environment jsdom
import { selectionArtifact } from '@buddy-shared/artifacts/__tests__/artifactSelectionFixture'
import { NMessageProvider } from 'naive-ui'
import { afterEach, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { WorkbenchSelectionReferences, workbenchSelectionReferencesKey } from '@/shared/ui/selection/workbenchSelectionReferences'
import DesktopArtifactContextSurface from '../DesktopArtifactContextSurface.vue'

vi.mock('../DesktopArtifactToolbar.vue', () => ({ default: defineComponent({ setup: () => () => null }) }))
vi.mock('@/shared/ui/media/BuddyImagePreview.vue', () => ({ default: defineComponent({ setup: () => () => null }) }))
vi.mock('@/shared/ui/files/DesktopDocumentContent.vue', () => ({ default: defineComponent({ props: ['text'], setup: props => () => h('article', props.text) }) }))
const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
})

function mountSurface(readArtifactText: InstanceType<typeof DesktopArtifactContextSurface>['$props']['readArtifactText']) {
  const root = document.createElement('div')
  document.body.append(root)
  const surface = () => h(DesktopArtifactContextSurface, {
    artifact: selectionArtifact,
    tabId: 'artifact:artifact-a',
    visible: true,
    language: 'zh-CN',
    viewMode: 'preview',
    readArtifactText,
    writeClipboardText: async () => {},
  })
  const app = createApp(() => h(NMessageProvider, {}, { default: surface }))
  app.provide(workbenchSelectionReferencesKey, new WorkbenchSelectionReferences({ targets: () => [] }))
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  return root
}

it('withholds unreadable text and quote actions, then recovers on retry', async () => {
  const readText = vi.fn().mockRejectedValueOnce({ code: 'FILE_ACCESS_DENIED' }).mockResolvedValue({ artifactId: selectionArtifact.artifactId, text: 'current', language: 'markdown' })
  const root = mountSurface(readText)
  await vi.waitFor(() => expect(root.textContent).toContain('操作系统拒绝访问该文件'))
  expect(root.querySelector('article, [role="menu"]')).toBeNull()
  const retry = [...root.querySelectorAll('button')].find(button => button.textContent?.includes('重试'))!
  retry.click()
  await vi.waitFor(() => expect(root.querySelector('article')?.textContent).toBe('current'))
  expect(root.textContent).not.toContain('操作系统拒绝访问该文件')
})
