// @vitest-environment jsdom
import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { BuddyComposerResource } from '@buddy-shared/conversation/composerResource'
import type { JSONContent } from '@tiptap/core'
import { BUDDY_ATTACHMENT_COUNT_LIMIT } from '@buddy-shared/conversation/attachmentPolicy'
import { Emitter } from '@buddy-shared/events/Emitter'
import { deferred } from '@buddy-tests/deferred'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { EditorContent } from '@tiptap/vue-3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, shallowRef } from 'vue'
import { chatComposerDocumentToUserContent, getChatComposerResourceIds, pruneChatComposerResources, userContentToChatComposerDocument } from '@/modules/prompt-input'
import { moveChatComposerResourceSelection } from '@/modules/prompt-input/ui'
import { useComposerResources } from '../../../state/composer/useComposerResources'
import ComposerResourceStrip from '../ComposerResourceStrip.vue'
import { useChatComposer } from '../useChatComposer'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

async function mountFlow() {
  const accepting = deferred<void>()
  const uploading = deferred<void>()
  const records = new Map<string, BuddyComposerResource>()
  const storedFiles = new Set<string>()
  const changes = new Emitter<{ revision: number, draftIds: string[] }>(() => {})
  const api: LocalChatApi['composerResources'] = {
    onChanged: (listener) => {
      const subscription = changes.event(listener)
      return () => subscription.dispose()
    },
    async accept(input) {
      await accepting.promise
      return input.resources.map((metadata) => {
        const resource: BuddyComposerResource = { ...metadata, draftId: input.draftId, kind: 'image', state: 'importing' }
        records.set(resource.resourceId, resource)
        return resource
      })
    },
    async complete(input) {
      await uploading.promise
      const existing = records.get(input.resourceId)!
      const resource: BuddyComposerResource = { ...existing, state: 'ready', attachmentId: `bytes-${input.resourceId}`, previewUrl: null }
      records.set(input.resourceId, resource)
      storedFiles.add(input.resourceId)
      return resource
    },
    async fail(input) {
      const existing = records.get(input.resourceId)!
      const resource: BuddyComposerResource = { ...existing, state: 'failed', errorCode: 'IMPORT_FAILED' }
      records.set(input.resourceId, resource)
      return resource
    },
    async list(draftId) { return [...records.values()].filter(resource => resource.draftId === draftId) },
    async listSources() { return { files: [] } },
    async retry(input) {
      const resource: BuddyComposerResource = { ...records.get(input.resourceId)!, state: 'importing' }
      records.set(input.resourceId, resource)
      return resource
    },
    async selectFiles() { return [] },
    async selectSource(input, referencedResourceIds = []) {
      if (referencedResourceIds.length >= BUDDY_ATTACHMENT_COUNT_LIMIT)
        throw new Error('Attachment limit exceeded')
      if ('localPath' in input.source || 'resourceId' in input.source)
        throw new Error('This fixture only supports legacy source selections')
      const source = 'bindingId' in input.source
        ? { ...input.source, bindingRevision: 1 }
        : 'messageId' in input.source
          ? { ...input.source, attachmentId: 'attachment-history' }
          : input.source
      const resource: BuddyComposerResource = {
        draftId: input.draftId,
        kind: 'text',
        mimeType: 'text/plain',
        name: 'oversized.txt',
        previewUrl: null,
        resourceId: input.resourceId,
        sizeBytes: 1,
        source,
        state: 'ready',
      }
      records.set(resource.resourceId, resource)
      return resource
    },
    async selectSpaceFile(input) {
      const resource: BuddyComposerResource = { draftId: input.draftId, resourceId: input.resourceId, name: 'notes.txt', kind: 'text', mimeType: 'text/plain', sizeBytes: 1, previewUrl: null, source: { ...input.source, bindingRevision: 1 }, state: 'ready' }
      records.set(resource.resourceId, resource)
      return resource
    },
  }
  const draftId = shallowRef('draft-1')
  const content = shallowRef<JSONContent>({
    attrs: { panelResourceIds: [] },
    content: [{ content: [], type: 'paragraph' }],
    type: 'doc',
  })
  const draft = shallowRef('')
  const errors: unknown[] = []
  const sent = vi.fn()
  const resources = useComposerResources({
    api,
    draftId,
    getReferencedIds: () => getChatComposerResourceIds(content.value as never),
    onError: error => errors.push(error),
    onLimitExceeded: () => errors.push(new Error('Limit exceeded')),
    onRejected: (_draftId, ids) => {
      if (content.value)
        content.value = pruneChatComposerResources(content.value as never, new Set(ids)) as never
    },
  })
  const root = document.createElement('div')
  document.body.append(root)
  let composer!: ReturnType<typeof useChatComposer>
  const app = createApp(defineComponent({
    setup() {
      composer = useChatComposer({
        canSend: shallowRef(true),
        composerContent: content,
        draft,
        draftId,
        resources: resources.resources,
        selectedModel: shallowRef(null),
        selectedEffort: shallowRef(null),
        selectedServiceTier: shallowRef(null),
        rejectedResourceIds: () => resources.rejectedIds,
        isRunning: shallowRef(false),
        isSending: shallowRef(false),
        language: shallowRef('zh-CN'),
        loadContextOptions: async () => ({ files: [], skills: [] }),
        beginImport: resources.begin,
        selectSource: resources.selectSource,
        onSend: sent,
        onUpdateContent: (text, value) => {
          draft.value = text
          content.value = value
        },
      })
      return () => h('div', [
        h(EditorContent, { editor: composer.editor.value }),
        h(ComposerResourceStrip, { disabled: false, language: 'zh-CN', resources: composer.resourceStripResources.value, onRemove: composer.removeResource, onRetry: resources.retry }),
      ])
    },
  }))
  app.mount(root)
  await nextTick()
  await nextTick()
  cleanups.push(() => {
    resources.dispose()
    changes.dispose()
    app.unmount()
    root.remove()
  })
  const editor = composer.editor.value!
  function pasteImages(names = ['red.png', 'blue.png']) {
    const files = names.map((name) => {
      const file = new File(['image-bytes'], name, { type: 'image/png' })
      Object.defineProperty(file, 'arrayBuffer', { value: async () => new ArrayBuffer(11) })
      return file
    })
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { files, getData: () => '' } })
    editor.view.dom.dispatchEvent(event)
  }
  return { sent, api, changes, accepting, uploading, records, storedFiles, content, draftId, resources, root, composer, editor, pasteImages, errors }
}

describe('composer resource flow', () => {
  it('reconciles owner notifications while fencing older reads and post-disposal delivery', async () => {
    const flow = await mountFlow()
    const stale = deferred<readonly BuddyComposerResource[]>()
    vi.spyOn(flow.api, 'list').mockImplementationOnce(() => stale.promise)
    flow.changes.fire({ revision: 1, draftIds: ['draft-1'] })
    await Promise.resolve()
    const resource: BuddyComposerResource = { resourceId: 'imported', draftId: 'draft-1', name: 'notes.txt', mimeType: 'text/plain', kind: 'text', sizeBytes: 1, state: 'failed', errorCode: 'IMPORT_FAILED' }
    flow.records.set(resource.resourceId, resource)
    flow.changes.fire({ revision: 2, draftIds: ['draft-1'] })
    stale.resolve([])
    await vi.waitFor(() => expect(flow.resources.resources.value.map(entry => entry.resource.resourceId)).toEqual(['imported']))
    flow.records.clear()
    flow.changes.fire({ revision: 3, draftIds: ['draft-1'] })
    await vi.waitFor(() => expect(flow.resources.resources.value).toEqual([]))
    flow.resources.dispose()
    flow.records.set(resource.resourceId, resource)
    flow.changes.fire({ revision: 4, draftIds: ['draft-1'] })
    await Promise.resolve()
    expect(flow.resources.resources.value).toEqual([])
  })

  it('hydrates file quotes without changing input focus and sends, removes and restores their snapshots', async () => {
    const flow = await mountFlow()
    const quote = { id: 'file-quote', text: '    frozen excerpt\n', source: { kind: 'file' as const, title: 'notes.md', file: { spaceId: 'space', directoryId: 'directory', revision: 1, path: 'notes.md' }, format: 'markdown' as const } }
    const focus = document.activeElement
    const original = chatComposerDocumentToUserContent(flow.editor.getJSON())
    flow.content.value = userContentToChatComposerDocument({ ...original, resourceQuotes: [quote] })
    await nextTick()
    expect(document.activeElement).toBe(focus)
    expect(flow.composer.resourceQuotes.value).toEqual([quote])
    expect(flow.composer.canSubmit.value).toBe(true)
    flow.composer.submit()
    expect(flow.sent).toHaveBeenCalledWith(expect.objectContaining({ userContent: expect.objectContaining({ resourceQuotes: [quote] }) }))
    expect(flow.records.size).toBe(0)
    flow.editor.commands.insertContent('normal question')
    flow.composer.removeResourceQuote(quote.id)
    expect(flow.composer.resourceQuotes.value).toEqual([])
    expect(flow.editor.getText()).toBe('normal question')
    flow.editor.commands.undo()
    expect(flow.composer.resourceQuotes.value).toEqual([quote])
    expect(flow.editor.getText()).toBe('normal question')
  })

  it('keeps identical excerpts from distinct positions while deduplicating the same selection', async () => {
    const flow = await mountFlow()
    const quote = { id: 'first', text: 'Repeat', textOffset: 0, source: { conversationId: 'conversation-1', branchId: 'branch-1', messageId: 'message-1', role: 'assistant' as const, runId: 'run-1' } }
    expect(flow.composer.addQuote(quote)).toBe('added')
    expect(flow.composer.addQuote({ ...quote, id: 'second', textOffset: 20 })).toBe('added')
    expect(flow.composer.addQuote({ ...quote, id: 'duplicate' })).toBe('duplicate')
    expect(flow.composer.quotes.value.map(item => item.textOffset)).toEqual([0, 20])
  })

  it('rejects overflowing quotes without altering the editor or accepted snapshots', async () => {
    const flow = await mountFlow()
    const source = { conversationId: 'conversation-1', branchId: 'branch-1', messageId: 'message-1', role: 'assistant' as const, runId: 'run-1' }
    for (let index = 0; index < 16; index++)
      expect(flow.composer.addQuote({ id: `quote-${index}`, source, text: `snapshot ${index}` })).toBe('added')
    const document = flow.editor.getJSON()
    expect(flow.composer.addQuote({ id: 'overflow', source, text: 'new snapshot' })).toBe('limit')
    expect(flow.editor.getJSON()).toEqual(document)
    flow.composer.removeQuote('quote-0')
    const afterRemoval = flow.editor.getJSON()
    expect(flow.composer.addQuote({ id: 'oversized', source, text: 'a'.repeat(32_769) })).toBe('limit')
    expect(flow.editor.getJSON()).toEqual(afterRemoval)
    expect(flow.records.size).toBe(0)
  })

  it('preserves quote whitespace through editing, hydration and undo without creating files', async () => {
    const flow = await mountFlow()
    const quote = { id: 'quote-1', text: '    enabled: true\n\n', source: { conversationId: 'conversation-1', branchId: 'branch-1', messageId: 'message-1', role: 'assistant' as const, runId: 'run-1' } }
    expect(flow.composer.addQuote(quote)).toBe('added')
    await nextTick()
    expect(flow.composer.canSubmit.value).toBe(true)
    expect(flow.composer.addQuote({ ...quote, id: 'quote-2' })).toBe('duplicate')
    expect(flow.editor.getText()).toBe('')
    expect(flow.records.size).toBe(0)
    const saved = chatComposerDocumentToUserContent(flow.content.value)
    expect(saved.quotes).toEqual([quote])
    flow.editor.commands.insertContent('question')
    flow.editor.commands.undo()
    expect(chatComposerDocumentToUserContent(flow.editor.getJSON()).quotes).toEqual([quote])
    flow.composer.removeQuote(quote.id)
    expect(flow.composer.quotes.value).toEqual([])
    flow.editor.commands.undo()
    expect(flow.composer.quotes.value).toEqual([quote])
    flow.content.value = userContentToChatComposerDocument({ ...saved, quotes: [{ ...quote, id: 'restored' }] })
    await nextTick()
    expect(flow.composer.quotes.value[0]?.id).toBe('restored')
    flow.editor.setEditable(false)
    expect(flow.composer.addQuote({ ...quote, text: 'new quote' })).toBe('unavailable')
    expect(flow.composer.quotes.value).toHaveLength(1)
  })

  it('shows both references and cards immediately; completion never changes selection or undo history', async () => {
    const flow = await mountFlow()
    flow.pasteImages()
    const ids = getChatComposerResourceIds(flow.editor.getJSON())
    await nextTick()
    expect(ids).toHaveLength(2)
    expect(flow.composer.canSubmit.value).toBe(false)
    expect(flow.storedFiles.size).toBe(0)
    flow.editor.commands.insertContent('later text')
    const selection = flow.editor.state.selection.toJSON()
    flow.accepting.resolve()
    await flow.resources.whenAccepted()
    flow.uploading.resolve()
    await vi.waitFor(() => expect(flow.composer.canSubmit.value).toBe(true))
    expect(flow.editor.state.selection.toJSON()).toEqual(selection)
    flow.editor.commands.undo()
    expect(flow.editor.getText()).not.toContain('later text')
    expect(getChatComposerResourceIds(flow.editor.getJSON())).toEqual(ids)
    flow.editor.commands.undo()
    expect(getChatComposerResourceIds(flow.editor.getJSON())).toEqual([])
    expect(flow.editor.state.doc.attrs.panelResourceIds).toEqual([])
    flow.editor.commands.redo()
    expect(getChatComposerResourceIds(flow.editor.getJSON())).toEqual(ids)
    expect(flow.storedFiles.size).toBe(2)
  })

  it('numbers same-name images across pastes and keeps repeated references and restored drafts consistent', async () => {
    const flow = await mountFlow()
    const labels = () => [...flow.root.querySelectorAll('.chat-resource-reference__label')].map(node => node.textContent)
    flow.pasteImages(['image.png', 'image.png'])
    await nextTick()
    expect(labels()).toEqual(['[Image #1]', '[Image #2]'])
    flow.pasteImages(['image.png'])
    await nextTick()
    expect(labels()).toEqual(['[Image #1]', '[Image #2]', '[Image #3]'])
    const [first, second] = getChatComposerResourceIds(flow.editor.getJSON())
    flow.editor.commands.insertContent({ attrs: { resourceId: first }, type: 'chatResourceReference' })
    await nextTick()
    expect(labels()).toEqual(['[Image #1]', '[Image #2]', '[Image #3]', '[Image #1]'])
    expect(flow.composer.resourceStripResources.value.map(card => card.imageLabel)).toEqual(['[Image #1]', '[Image #2]', '[Image #3]'])
    flow.composer.removeResource(second!)
    await nextTick()
    expect(labels()).toEqual(['[Image #1]', '[Image #2]', '[Image #1]'])
    flow.editor.commands.undo()
    await nextTick()
    expect(labels()).toEqual(['[Image #1]', '[Image #2]', '[Image #3]', '[Image #1]'])
    const saved = chatComposerDocumentToUserContent(flow.editor.getJSON())
    flow.accepting.resolve()
    flow.uploading.resolve()
    await flow.resources.whenAccepted()
    await vi.waitFor(() => expect(flow.composer.canSubmit.value).toBe(true))
    flow.editor.commands.clearContent()
    await nextTick()
    flow.content.value = userContentToChatComposerDocument(saved)
    await nextTick()
    expect(labels()).toEqual(['[Image #1]', '[Image #2]', '[Image #3]', '[Image #1]'])
  })

  it('selects an adjacent inline resource with the arrow key', async () => {
    const flow = await mountFlow()
    flow.editor.commands.insertContent([
      { attrs: { resourceId: 'resource-1' }, type: 'chatResourceReference' },
      { text: ' ', type: 'text' },
    ])
    let resourcePosition = -1
    flow.editor.state.doc.descendants((node, position) => {
      if (node.type.name === 'chatResourceReference')
        resourcePosition = position
    })
    flow.editor.view.dispatch(flow.editor.state.tr.setSelection(
      TextSelection.create(flow.editor.state.doc, resourcePosition + 1),
    ))

    expect(moveChatComposerResourceSelection(flow.editor, -1)).toBe(true)
    await nextTick()
    expect(flow.editor.state.selection).toBeInstanceOf(NodeSelection)
    expect(flow.root.querySelector('[data-type="chat-resource-reference"]')?.classList.contains('ProseMirror-selectednode')).toBe(true)
  })

  it('removes a card and all inline appearances in one undoable edit while deleting an inline occurrence retains independent attachments', async () => {
    const flow = await mountFlow()
    flow.pasteImages()
    const [first, second] = getChatComposerResourceIds(flow.editor.getJSON())
    flow.composer.removeResource(first!)
    expect(flow.editor.state.doc.attrs.panelResourceIds).toEqual([second])
    expect(getChatComposerResourceIds(flow.editor.getJSON())).toEqual([second])
    expect(flow.editor.view.dom.querySelectorAll('[data-type="chat-resource-reference"]')).toHaveLength(1)
    flow.editor.commands.undo()
    expect(flow.editor.state.doc.attrs.panelResourceIds).toEqual([first, second])
    flow.editor.commands.deleteRange({ from: 1, to: 2 })
    expect(flow.editor.state.doc.attrs.panelResourceIds).toEqual([first, second])
    expect(flow.editor.view.dom.querySelectorAll('[data-type="chat-resource-reference"]')).toHaveLength(1)
    flow.accepting.resolve()
    flow.uploading.resolve()
    await flow.resources.whenAccepted()
  })

  it('derives a single reference card from repeated inline occurrences and restores its lifetime with undo', async () => {
    const flow = await mountFlow()
    const id = await flow.resources.selectSource({ bindingId: 'binding-1', relativePath: 'notes.txt', spaceId: 'space-1' })
    flow.editor.commands.insertContent([
      { attrs: { resourceId: id }, type: 'chatResourceReference' },
      { text: ' plus ', type: 'text' },
      { attrs: { resourceId: id }, type: 'chatResourceReference' },
    ])
    await nextTick()
    expect(flow.root.querySelectorAll('.composer-resource-strip__card')).toHaveLength(1)
    flow.editor.commands.deleteRange({ from: 1, to: 2 })
    await nextTick()
    expect(flow.root.querySelectorAll('.composer-resource-strip__card')).toHaveLength(1)
    const last = flow.editor.state.doc.firstChild!.nodeSize - 2
    flow.editor.commands.deleteRange({ from: last, to: last + 1 })
    await nextTick()
    expect(flow.root.querySelectorAll('.composer-resource-strip__card')).toHaveLength(0)
    expect(flow.editor.getText()).toBe(' plus ')
    flow.editor.commands.undo()
    await nextTick()
    expect(flow.root.querySelectorAll('.composer-resource-strip__card')).toHaveLength(1)
    flow.composer.removeResource(id!)
    expect(getChatComposerResourceIds(flow.editor.getJSON())).toEqual([])
    expect(flow.editor.getText()).toBe(' plus ')
    flow.editor.commands.undo()
    expect(getChatComposerResourceIds(flow.editor.getJSON())).toEqual([id])
  })

  it('removes a rejected provisional batch without losing later typing or resurrecting invalid IDs on redo', async () => {
    const flow = await mountFlow()
    flow.pasteImages()
    flow.editor.commands.insertContent('keep this text')
    flow.accepting.reject(new Error('Metadata rejected'))
    await vi.waitFor(() => expect(flow.errors).toHaveLength(1))
    expect(flow.editor.getText()).toBe('keep this text')
    expect(getChatComposerResourceIds(flow.editor.getJSON())).toEqual([])
    flow.editor.commands.undo()
    flow.editor.commands.undo()
    flow.editor.commands.redo()
    flow.editor.commands.redo()
    expect(getChatComposerResourceIds(flow.editor.getJSON())).toEqual([])
    expect(flow.editor.getText()).toBe('keep this text')
  })

  it('keeps import results bound to their originating draft after navigation', async () => {
    const flow = await mountFlow()
    flow.pasteImages()
    const ids = getChatComposerResourceIds(flow.editor.getJSON())
    flow.draftId.value = 'draft-2'
    flow.accepting.resolve()
    await flow.resources.whenAccepted()
    flow.uploading.resolve()
    await vi.waitFor(() => expect(flow.storedFiles.size).toBe(2))
    expect(flow.resources.resources.value).toEqual([])
    flow.draftId.value = 'draft-1'
    expect(flow.resources.resources.value.map(entry => entry.resource.resourceId)).toEqual(ids)
  })

  it('keeps same-draft cut/paste identity while external and cross-draft paste use readable text', async () => {
    const flow = await mountFlow()
    flow.pasteImages()
    flow.accepting.resolve()
    flow.uploading.resolve()
    await flow.resources.whenAccepted()
    const [first] = getChatComposerResourceIds(flow.editor.getJSON())
    flow.editor.commands.setTextSelection({ from: 1, to: 2 })
    const data = new Map<string, string>()
    const clipboardData = { files: [], getData: (type: string) => data.get(type) ?? '', setData: (type: string, value: string) => data.set(type, value) }
    function clipboardEvent(type: string) {
      const event = new Event(type, { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: clipboardData })
      return event
    }
    flow.editor.view.dom.dispatchEvent(clipboardEvent('cut'))
    expect(flow.editor.view.dom.querySelectorAll('[data-type="chat-resource-reference"]')).toHaveLength(1)
    expect(flow.editor.state.doc.attrs.panelResourceIds).toContain(first)
    expect(data.get('text/plain')).toBe('[Image #1]')
    expect(data.get('text/html')).not.toContain(first)
    flow.editor.view.dom.dispatchEvent(clipboardEvent('paste'))
    expect(flow.editor.state.doc.firstChild!.firstChild!.attrs.resourceId).toBe(first)
    expect(flow.editor.view.dom.querySelectorAll('[data-type="chat-resource-reference"]')).toHaveLength(2)

    const other = await mountFlow()
    other.draftId.value = 'draft-2'
    other.editor.view.dom.dispatchEvent(clipboardEvent('paste'))
    expect(getChatComposerResourceIds(other.editor.getJSON())).toEqual([])
    expect(other.editor.getText()).toBe('[Image #1]')
    expect(other.storedFiles.size).toBe(0)
    const nextSession = await mountFlow()
    expect(nextSession.draftId.value).toBe(flow.draftId.value)
    nextSession.editor.view.dom.dispatchEvent(clipboardEvent('paste'))
    expect(getChatComposerResourceIds(nextSession.editor.getJSON())).toEqual([])
    expect(nextSession.editor.getText()).toBe('[Image #1]')
  })

  it('does not leave a source card in the renderer when the combined input limit rejects it', async () => {
    const flow = await mountFlow()
    flow.editor.commands.setContent({
      attrs: { panelResourceIds: [] },
      content: [{
        content: Array.from({ length: BUDDY_ATTACHMENT_COUNT_LIMIT }, (_, index) => ({
          attrs: { resourceId: `existing-${index}` },
          type: 'chatResourceReference',
        })),
        type: 'paragraph',
      }],
      type: 'doc',
    })

    await expect(flow.resources.selectSource({
      bindingId: 'binding-1',
      relativePath: 'oversized.txt',
      spaceId: 'space-1',
    })).resolves.toBeNull()

    expect(flow.resources.resources.value).toEqual([])
    expect(flow.errors).toHaveLength(1)
  })

  it('keeps a failed inline-only resource visible and removes all of its placements', async () => {
    const flow = await mountFlow()
    flow.pasteImages()
    const [first] = getChatComposerResourceIds(flow.editor.getJSON())
    flow.composer.removePanelResource(first!)
    flow.accepting.resolve()
    flow.uploading.reject(new Error('upload failed'))

    await vi.waitFor(() => expect(flow.resources.resources.value[0]?.resource.state).toBe('failed'))
    expect(flow.composer.resourceStripResources.value.map(entry => entry.resource.resourceId)).toContain(first)

    flow.composer.removeResource(first!)

    expect(getChatComposerResourceIds(flow.editor.getJSON())).not.toContain(first)
    expect(flow.editor.state.doc.attrs.panelResourceIds).not.toContain(first)
  })
})
