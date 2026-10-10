// @vitest-environment jsdom
import type { JSONContent } from '@tiptap/core'
import type { ComposerResourceView } from '../../../state/composer/typing'
import type { DesktopChatComposerProps } from '../typing'
import type { ChatPromptContextOption } from '@/modules/prompt-input'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, shallowReactive } from 'vue'
import { createChatComposerContentFromText, getChatComposerResourceIds } from '@/modules/prompt-input'
import DesktopChatComposer from '../DesktopChatComposer.vue'

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

function sourceOption(name: string): ChatPromptContextOption {
  return {
    description: null,
    kind: 'file',
    label: name,
    path: name,
    source: { bindingId: 'binding-1', relativePath: name, spaceId: 'space-1' },
    value: name,
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
    resources: [resource('old-resource'), resource('new-resource'), resource('selected-resource')],
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
    loadContextOptions: async () => ({ files: [sourceOption('old-context.txt')], skills: [] }),
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
  async function openFilePicker() {
    root.querySelector<HTMLButtonElement>('.desktop-chat-composer__source-trigger')!.click()
    await nextTick()
    await nextTick()
    document.querySelectorAll<HTMLButtonElement>('.desktop-chat-composer__source-action')[1]!.click()
    await nextTick()
  }
  return { dropFile, openFilePicker, props, root }
}

describe('chat composer prop updates', () => {
  it('uses a replaced import callback and prunes resources when the rejected Set prop is replaced', async () => {
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

  it('renders new context results and inserts the source returned by replacement callback props', async () => {
    const flow = await mountComposer()
    await flow.openFilePicker()
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toContain('old-context.txt'))
    document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }))
    await nextTick()

    flow.props.loadContextOptions = async () => ({ files: [sourceOption('new-context.txt')], skills: [] })
    flow.props.selectSource = async () => 'selected-resource'
    await nextTick()
    await flow.openFilePicker()
    await vi.waitFor(() => expect(document.querySelector('[role="option"]')?.textContent).toContain('new-context.txt'))
    document.querySelector<HTMLButtonElement>('[role="option"]')!.click()
    await vi.waitFor(() => expect(getChatComposerResourceIds(flow.props.composerContent)).toEqual(['selected-resource']))
    expect(flow.root.textContent).toContain('selected-resource.txt')
    expect(flow.root.querySelector('.desktop-chat-composer__source-trigger')?.getAttribute('aria-expanded')).toBe('false')
  })
})
