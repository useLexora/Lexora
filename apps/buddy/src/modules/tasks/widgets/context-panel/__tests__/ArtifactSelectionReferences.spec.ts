// @vitest-environment jsdom
import { selectionArtifact } from '@buddy-shared/artifacts/__tests__/artifactSelectionFixture'
import { expect, it, vi } from 'vitest'
import { createApp, defineComponent, h } from 'vue'
import { WorkbenchSelectionReferences, workbenchSelectionReferencesKey } from '@/shared/ui/selection/workbenchSelectionReferences'
import DesktopArtifactContextSurface from '../DesktopArtifactContextSurface.vue'

vi.mock('naive-ui', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    NSpin: defineComponent({ setup: () => () => h('span', 'Loading') }),
    useMessage: () => ({ success: vi.fn(), info: vi.fn(), warning: vi.fn() }),
  }
})
vi.mock('../DesktopArtifactToolbar.vue', () => ({ default: defineComponent({ setup: () => () => null }) }))
vi.mock('@/shared/ui/media/BuddyImagePreview.vue', () => ({ default: defineComponent({ setup: () => () => null }) }))
vi.mock('@/shared/ui/files/DesktopDocumentContent.vue', () => ({ default: defineComponent({ setup: () => () => h('article') }) }))

it('does not expose quote actions when artifact text loading fails', async () => {
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp({
    render: () => h(DesktopArtifactContextSurface, {
      artifact: selectionArtifact,
      tabId: 'artifact:artifact-a',
      visible: true,
      language: 'zh-CN',
      viewMode: 'preview',
      readArtifactText: async () => { throw new Error('Artifact unavailable') },
      writeClipboardText: async () => {},
    }),
  })
  app.provide(workbenchSelectionReferencesKey, new WorkbenchSelectionReferences({ targets: () => [] }))
  try {
    app.mount(root)
    await vi.waitFor(() => expect(root.textContent).toContain('无法读取该文件预览'))
    expect(root.querySelector('article, [role="menu"]')).toBeNull()
  }
  finally {
    app.unmount()
    root.remove()
  }
})
