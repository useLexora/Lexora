// @vitest-environment jsdom
import type { JSONContent } from '@tiptap/core'
import type { ComposerResourceView } from '../../../state/composer/typing'
import type { DesktopChatComposerProps } from '../typing'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, shallowReactive } from 'vue'
import { createChatComposerContentFromText, getChatComposerResourceIds } from '@/modules/prompt-input'
import DesktopChatComposer from '../DesktopChatComposer.vue'

beforeEach(() => {
  vi.stubGlobal('lexoraDesktop', {
    speech: { onChanged: () => () => {}, catalog: async () => ({ providers: [], preferences: {} }) },
    app: { onHidden: () => () => {}, onBeforeQuit: () => () => {} },
    settings: { onChanged: () => () => {} },
  })
})
afterEach(() => vi.unstubAllGlobals())
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

function resource(resourceId: string): ComposerResourceView {
  return {
    accepted: true,
    canRetry: false,
    resource: {
      attachmentId: `attachment-${resourceId}`,
      draftId: 'draft-1',
      kind: 'text',
      mimeType: 'text/plain',
      name: `${resourceId}.txt`,
      previewUrl: null,
      resourceId,
      sizeBytes: 1,
      state: 'ready',
    },
  }
}

async function mountComposer() {
  const props = shallowReactive<DesktopChatComposerProps>({
    pasteTextAsAttachment: true,
    canUpdatePermissionSettings: true,
    canSend: true,
    composerContent: createChatComposerContentFromText(''),
    contextUsage: null,
    draft: '',
    draftId: 'draft-1',
    editorKey: 'editor-1',
    resources: [resource('old-resource'), resource('new-resource')],
    rejectedResourceIds: new Set(),
    beginImport: () => ['old-resource'],
    importPastedText: async () => null,
    readResourceText: async () => '',
    selectSource: async () => null,
    isRunning: false,
    isStopping: false,
    isSelectingFiles: false,
    isSending: false,
    isUpdatingPermissionSettings: false,
    interaction: null,
    language: 'zh-CN',
    loadContextOptions: async () => ({ files: [], skills: [] }),
    models: [],
    permissionMode: 'manual_approval',
    providers: [],
    selectedEffort: null,
    selectedModel: null,
    selectedModelId: null,
    selectedServiceTier: null,
  })
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(defineComponent({
    setup() {
      return () => h(DesktopChatComposer, {
        ...props,
        onUpdateContent: (content: string, value: JSONContent) => {
          props.draft = content
          props.composerContent = value
        },
      })
    },
  }))
  app.mount(root)
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  await nextTick()
  await nextTick()

  function dropFile() {
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { files: [new File(['notes'], 'notes.txt', { type: 'text/plain' })] } })
    root.querySelector('.desktop-chat-composer-wrap')!.dispatchEvent(event)
  }
  return { dropFile, props, root }
}

describe('chat composer prop updates', () => {
  it('prunes rejected resources without discarding a later valid import', async () => {
    const flow = await mountComposer()
    flow.dropFile()
    await nextTick()
    expect(getChatComposerResourceIds(flow.props.composerContent)).toEqual(['old-resource'])

    flow.props.beginImport = () => ['new-resource']
    await nextTick()
    flow.dropFile()
    await nextTick()
    expect(getChatComposerResourceIds(flow.props.composerContent)).toEqual(['old-resource', 'new-resource'])

    flow.props.rejectedResourceIds = new Set(['old-resource'])
    await nextTick()
    await nextTick()
    expect(getChatComposerResourceIds(flow.props.composerContent)).toEqual(['new-resource'])
    expect(flow.root.textContent).not.toContain('old-resource.txt')
    expect(flow.root.textContent).toContain('new-resource.txt')
  })
})
