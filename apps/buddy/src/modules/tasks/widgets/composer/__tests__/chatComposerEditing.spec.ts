// @vitest-environment jsdom
import type { BuddyComposerSource } from '@buddy-shared/conversation/composerResource'
import type { BuddyServiceTier, BuddyThinkingLevel } from '@buddy-shared/conversation/modelSelection'
import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { ComposerResourceView } from '../../../state/composer/typing'
import type { ChatComposerContextOptions, ChatComposerSessionScope, ChatComposerSubmitPayload, ChatPromptContextOption } from '@/modules/prompt-input'
import type { WorkbenchCommandPort } from '@/shared/ui/contributions/workbenchCommands'
import { resourceQuoteText } from '@buddy-shared/conversation/buddyResourceQuoteText'
import { deferred } from '@buddy-tests/deferred'
import { EditorContent } from '@tiptap/vue-3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, defineComponent, h, nextTick, shallowRef } from 'vue'
import { chatComposerDocumentToUserContent, createChatComposerContentFromText, getChatComposerResourceIds } from '@/modules/prompt-input'
import { replaceChatComposerDocument } from '@/modules/prompt-input/editor/chatComposerResourceEditing'
import { insertChatComposerResources, insertChatComposerSessionReferences } from '@/modules/prompt-input/ui'
import { useProvideWorkbenchCommands } from '@/shared/ui/contributions/workbenchCommands'
import { copyReferenceClipboard } from '@/shared/ui/selection/referenceClipboard'
import { CONVERSATION_STATUS_PANEL_KEY } from '../../../state/runs/conversationStatusPanel'
import { useChatComposer } from '../useChatComposer'

const cleanups: (() => void)[] = []
afterEach(() => {
  cleanups.splice(0).forEach(cleanup => cleanup())
  vi.restoreAllMocks()
})

function fileOption(name: string): ChatPromptContextOption {
  return {
    description: null,
    kind: 'file',
    label: name,
    path: name,
    source: { bindingId: 'binding-1', relativePath: name, spaceId: 'space-1' },
    value: name,
  }
}

function skillOption(name: string, description: string): ChatPromptContextOption {
  return {
    description,
    kind: 'skill',
    label: name,
    path: null,
    skill: { id: `${name}-id`, name, revision: 'revision-one' },
    value: name,
  }
}

async function mountComposer(options: {
  loadContextOptions?: (query: string | null, deepSearch?: boolean, scope?: ChatComposerSessionScope) => Promise<ChatComposerContextOptions>
  selectSource?: (source: BuddyComposerSource) => Promise<string | null>
  model?: LocalRuntimeModelOption
  statusPanel?: boolean
  commands?: WorkbenchCommandPort
} = {}) {
  const canSend = shallowRef(true)
  const statusPanelOpen = shallowRef(false)
  const content = shallowRef(createChatComposerContentFromText(''))
  const draft = shallowRef('')
  const draftId = shallowRef('draft-1')
  const resources = shallowRef<readonly ComposerResourceView[]>([])
  const selectedEffort = shallowRef<BuddyThinkingLevel | null>(null)
  const selectedServiceTier = shallowRef<BuddyServiceTier | null>(null)
  const sent: string[] = []
  const sentPayloads: ChatComposerSubmitPayload[] = []
  let composer!: ReturnType<typeof useChatComposer>
  const root = document.createElement('div')
  document.body.append(root)
  const component = defineComponent({
    setup() {
      composer = useChatComposer({
        pasteTextAsAttachment: shallowRef(true),
        canSend,
        composerContent: content,
        draft,
        draftId,
        resources,
        rejectedResourceIds: () => new Set(),
        isRunning: shallowRef(false),
        isSending: shallowRef(false),
        language: shallowRef('zh-CN'),
        selectedModel: shallowRef(options.model ?? null),
        selectedEffort,
        selectedServiceTier,
        loadContextOptions: options.loadContextOptions ?? (async () => ({ files: [], skills: [] })),
        beginImport: () => [],
        importPastedText: async () => null,
        readResourceText: async () => '',
        selectSource: options.selectSource ?? (async () => null),
        onSend: (payload) => {
          sent.push(payload.content)
          sentPayloads.push(payload)
        },
        onUpdateContent: (text, value) => {
          draft.value = text
          content.value = value
        },
      })
      return () => [
        h(EditorContent, { editor: composer.editor.value }),
        statusPanelOpen.value ? h('aside', { 'data-testid': 'conversation-status-panel' }, 'Conversation status') : null,
      ]
    },
  })
  const app = createApp(defineComponent({
    setup() {
      if (options.commands)
        useProvideWorkbenchCommands(options.commands)
      return () => h(component)
    },
  }))
  if (options.statusPanel !== false)
    app.provide(CONVERSATION_STATUS_PANEL_KEY, { open: () => { statusPanelOpen.value = true } })
  app.mount(root)
  await nextTick()
  await nextTick()
  cleanups.push(() => {
    app.unmount()
    root.remove()
  })
  const editor = composer.editor.value!
  function keydown(key: string, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...init })
    editor.view.dom.dispatchEvent(event)
    return event
  }
  return { canSend, composer, content, draft, draftId, editor, keydown, resources, root, selectedEffort, selectedServiceTier, sent, sentPayloads }
}

describe('chat composer editing', () => {
  it('pastes a host-copied snapshot into the current task without changing another draft or leaking its locator into the prompt', async () => {
    const first = await mountComposer()
    first.editor.commands.insertContent('First task draft')
    const quote = { id: crypto.randomUUID(), text: 'Selected paragraph', source: { kind: 'view' as const, title: 'Report.pdf', provider: 'extension:tests.office', target: { extensionId: 'tests.office', viewId: crypto.randomUUID(), viewType: 'tests.office.editor', source: null } }, locator: { version: 1, data: { documentId: 'opaque-private-document', page: 2 } } }
    const copying = deferred<void>()
    let copied = { text: '', html: '' }
    const pending = copyReferenceClipboard(quote, async (text, html) => {
      copied = { text, html: html! }
      await copying.promise
    })
    const current = await mountComposer()
    current.draftId.value = 'draft-2'
    current.editor.commands.insertContent('Second task draft ')
    copying.resolve()
    await pending
    function paste() {
      const event = new Event('paste', { bubbles: true, cancelable: true })
      Object.defineProperty(event, 'clipboardData', { value: { getData: (format: string) => format === 'text/html' ? copied.html : copied.text } })
      current.editor.view.dom.dispatchEvent(event)
      return event
    }
    expect(paste().defaultPrevented).toBe(true)
    expect(first.editor.getText()).toBe('First task draft')
    expect(current.editor.getText()).toContain('Second task draft')
    const content = chatComposerDocumentToUserContent(current.editor.getJSON())
    expect(content.resourceQuotes).toEqual([quote])
    expect(content.body.flatMap(paragraph => paragraph.content).filter(node => node.type === 'quote_ref')).toEqual([{ type: 'quote_ref', quoteKind: 'resource', quoteId: quote.id }])
    const prompt = resourceQuoteText(content.resourceQuotes)
    expect(prompt).toContain('Selected paragraph')
    expect(prompt).not.toContain('opaque-private-document')
    expect(prompt).not.toContain(quote.id)
    expect(paste().defaultPrevented).toBe(true)
    expect(chatComposerDocumentToUserContent(current.editor.getJSON()).resourceQuotes).toHaveLength(1)
    expect(first.sentPayloads).toEqual([])
    expect(current.sentPayloads).toEqual([])
  })

  it('keeps pasted references separate from adjacent typing through undo and redo', async () => {
    const flow = await mountComposer()
    vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    flow.editor.commands.insertContent('Before ')
    const before = flow.editor.getJSON()
    const quote = { id: crypto.randomUUID(), text: 'Selected paragraph', source: { kind: 'view' as const, title: 'Report', provider: 'extension:tests.office', target: null } }
    let clipboard = { text: '', html: '' }
    await copyReferenceClipboard(quote, async (text, html) => {
      clipboard = { text, html: html! }
    })
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { getData: (format: string) => format === 'text/html' ? clipboard.html : clipboard.text } })
    flow.editor.view.dom.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    const pasted = flow.editor.getJSON()
    expect(chatComposerDocumentToUserContent(pasted).resourceQuotes).toEqual([quote])
    flow.editor.commands.insertContent(' after')
    const typed = flow.editor.getJSON()

    expect(flow.editor.commands.undo()).toBe(true)
    expect(flow.editor.getJSON()).toEqual(pasted)
    expect(flow.editor.commands.undo()).toBe(true)
    expect(flow.editor.getJSON()).toEqual(before)
    expect(chatComposerDocumentToUserContent(flow.editor.getJSON()).resourceQuotes ?? []).toEqual([])
    expect(flow.editor.commands.redo()).toBe(true)
    expect(flow.editor.getJSON()).toEqual(pasted)
    expect(flow.editor.commands.redo()).toBe(true)
    expect(flow.editor.getJSON()).toEqual(typed)
  })

  it('consumes an over-limit reference paste and shows the existing quota message without inserting plain text', async () => {
    const flow = await mountComposer()
    const quotes = Array.from({ length: 16 }, (_, index) => ({ id: crypto.randomUUID(), text: `Snapshot ${index}`, source: { kind: 'view' as const, title: 'Report', provider: 'extension:tests.office', target: null } }))
    replaceChatComposerDocument(flow.editor, { version: 1, body: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep draft' }] }], panelResourceIds: [], resourceQuotes: quotes })
    const before = flow.editor.getJSON()
    let clipboard = { text: '', html: '' }
    await copyReferenceClipboard({ ...quotes[0]!, id: crypto.randomUUID(), text: 'Must not degrade to plain text' }, async (text, html) => {
      clipboard = { text, html: html! }
    })
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { getData: (format: string) => format === 'text/html' ? clipboard.html : clipboard.text } })
    flow.editor.view.dom.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(flow.editor.getJSON()).toEqual(before)
    expect(flow.composer.quotePasteLimitMessage.value).toContain('每条消息最多 16 条引用')
    flow.draftId.value = 'another-draft'
    expect(flow.composer.quotePasteLimitMessage.value).toBeNull()
  })

  it('keeps two plugin skills with the same invocation bound to their selected sources', async () => {
    const skills = ['publisher-one.tables', 'publisher-two.tables'].map(id => ({
      ...skillOption('tables:review', `${id} instructions`),
      skill: { id, name: 'tables:review', revision: `revision-${id}` },
      skillScope: 'global' as const,
      skillPlugin: { extensionId: id, extensionName: 'Tables' },
    }))
    const flow = await mountComposer({ loadContextOptions: async () => ({ files: [], skills }) })
    for (const skill of skills) {
      flow.editor.commands.insertContent('$tables:review')
      flow.composer.activeTrigger.value = { kind: 'skill', query: 'tables:review' }
      await flow.composer.loadContextOptions(null)
      expect(flow.composer.suggestions.value.map(({ option }) => 'skill' in option ? option.skill?.id : undefined)).toEqual(skills.map(option => option.skill.id))
      flow.composer.selectSuggestion(skill)
    }
    flow.composer.submit()
    const directives = flow.sentPayloads[0]?.userContent?.body.flatMap(paragraph => paragraph.content.filter(node => node.type === 'prompt_directive'))
    expect(directives).toEqual(skills.map(option => ({ type: 'prompt_directive', directive: 'skill', value: 'tables:review', skill: option.skill })))
  })

  it('selects same-name actors by keyboard and sends stable inline references without attachments', async () => {
    const actors: ChatPromptContextOption[] = ['actor-one', 'actor-two'].map(actorId => ({
      actorReference: { type: 'actor_ref', actorId, name: '星野' },
      category: 'actors',
      kind: 'actorReference',
      label: '星野',
      description: null,
      path: null,
      value: actorId,
    }))
    const flow = await mountComposer({ loadContextOptions: async () => ({ files: [], skills: [], actors }) })
    flow.editor.view.dom.focus()
    flow.editor.commands.insertContent('请 @星')
    await expect.poll(() => flow.composer.suggestions.value.length).toBe(2)
    flow.keydown('ArrowDown')
    flow.keydown('Enter')
    flow.editor.commands.insertContent('检查结果')
    expect(flow.editor.getText()).toBe('请 @星野 检查结果')
    expect(flow.composer.activeTrigger.value).toBeNull()
    expect(flow.sentPayloads).toEqual([])
    flow.keydown('Enter')
    expect(flow.sentPayloads[0]?.userContent).toEqual({
      version: 1,
      body: [{ type: 'paragraph', content: [
        { type: 'text', text: '请 ' },
        actors[1]!.actorReference,
        { type: 'text', text: ' 检查结果' },
      ] }],
      panelResourceIds: [],
    })
  })

  it('keeps a referenced session unsendable until the body contains non-whitespace text', async () => {
    const flow = await mountComposer()
    insertChatComposerSessionReferences(flow.editor, [{ id: 'session-1', title: 'History' }])
    await nextTick()

    expect(flow.composer.canSubmit.value).toBe(false)
    flow.editor.commands.insertContent('   ')
    await nextTick()
    expect(flow.composer.canSubmit.value).toBe(false)
    flow.composer.submit()
    expect(flow.sentPayloads).toEqual([])

    flow.editor.commands.insertContent('question')
    await nextTick()
    expect(flow.composer.canSubmit.value).toBe(true)
    flow.composer.submit()
    expect(flow.sentPayloads).toHaveLength(1)
  })

  it('submits a run action with its arguments from suggestions', async () => {
    const flow = await mountComposer()
    const prefix = '/com'
    flow.editor.commands.setContent(createChatComposerContentFromText(`${prefix} preserve decisions`))
    flow.editor.commands.setTextSelection(prefix.length + 1)
    flow.composer.activeTrigger.value = { kind: 'slash', query: 'com' }
    flow.composer.selectSuggestion({ kind: 'slashCommand', value: '/compact', label: '/compact', description: null, path: null })
    expect(flow.sentPayloads[0]?.userContent?.body[0]?.content[0]).toEqual({
      type: 'prompt_directive',
      directive: 'slash_command',
      commandMode: 'action',
      value: '/compact',
    })
    expect(flow.sent).toEqual(['/compact  preserve decisions'])
  })

  it('opens a view action without sending or losing structured input', async () => {
    const flow = await mountComposer()
    flow.canSend.value = false
    const prefix = '/status'
    const quote = { id: 'quote', text: 'quoted evidence', source: { conversationId: 'conversation', branchId: 'branch', messageId: 'message', role: 'assistant', runId: 'run' } }
    replaceChatComposerDocument(flow.editor, chatComposerDocumentToUserContent({ type: 'doc', attrs: { panelResourceIds: ['panel'], quotes: [quote] }, content: [{ type: 'paragraph', content: [
      { type: 'text', text: `${prefix} keep this text ` },
      { type: 'chatResourceReference', attrs: { resourceId: 'inline' } },
    ] }] }))
    flow.composer.submit()
    await nextTick()
    expect(flow.root.querySelector('[data-testid="conversation-status-panel"]')?.textContent).toBe('Conversation status')
    expect(flow.sent).toEqual([])
    expect(chatComposerDocumentToUserContent(flow.editor.getJSON())).toMatchObject({
      body: [{ content: [{ type: 'text', text: ' keep this text ' }, { type: 'resource_ref', resourceId: 'inline' }] }],
      panelResourceIds: ['panel'],
      quotes: [quote],
    })
  })

  it('keeps an unavailable view action in the draft instead of sending it as a message', async () => {
    const flow = await mountComposer({ statusPanel: false })
    flow.editor.commands.setContent(createChatComposerContentFromText('/status keep this text'))
    flow.composer.submit()
    expect(flow.editor.getText()).toBe('/status keep this text')
    expect(flow.sent).toEqual([])
  })

  it('starts a new task from suggestions while preserving the remaining input', async () => {
    const executions: string[] = []
    const commands = localCommands(async (id) => {
      executions.push(id)
      return null
    })
    commands.entries.value = [{ id: 'task.newInSpace', name: 'new', title: 'New task in current space' }]
    const flow = await mountComposer({ commands })
    flow.canSend.value = false
    const prefix = '/ne'
    replaceChatComposerDocument(flow.editor, chatComposerDocumentToUserContent({ type: 'doc', attrs: { panelResourceIds: ['panel'] }, content: [{ type: 'paragraph', content: [
      { type: 'text', text: `${prefix} keep this text ` },
      { type: 'chatResourceReference', attrs: { resourceId: 'inline' } },
    ] }] }))
    flow.editor.commands.setTextSelection(prefix.length + 1)
    flow.composer.activeTrigger.value = { kind: 'slash', query: 'ne' }
    const suggestions = flow.composer.suggestions.value.filter(item => item.option.value === '/new')
    expect(suggestions).toHaveLength(1)
    flow.composer.selectSuggestion(suggestions[0]!.option)
    await nextTick()
    expect(executions).toEqual(['task.newInSpace'])
    expect(flow.sent).toEqual([])
    expect(chatComposerDocumentToUserContent(flow.editor.getJSON())).toMatchObject({
      body: [{ content: [{ type: 'text', text: ' keep this text ' }, { type: 'resource_ref', resourceId: 'inline' }] }],
      panelResourceIds: ['panel'],
    })
  })

  it('keeps an unavailable new task action in the draft', async () => {
    const flow = await mountComposer()
    flow.editor.commands.setContent(createChatComposerContentFromText('/new keep this text'))
    flow.composer.submit()
    expect(flow.editor.getText()).toBe('/new keep this text')
    expect(flow.sent).toEqual([])
  })

  it('preserves structured input when a review command is selected and submitted', async () => {
    const flow = await mountComposer()
    const prefix = '/rev'
    const skill = { id: 'writer-id', name: 'writer', revision: 'revision-one' }
    const quote = { id: 'quote', text: 'quoted evidence', source: { conversationId: 'conversation', branchId: 'branch', messageId: 'message', role: 'assistant', runId: 'run' } }
    flow.resources.value = ['inline', 'panel'].map(resourceId => ({ accepted: true, canRetry: false, resource: { draftId: 'draft-1', resourceId, kind: 'text', mimeType: 'text/plain', name: `${resourceId}.txt`, sizeBytes: 10, state: 'ready', attachmentId: resourceId, previewUrl: null } }))
    replaceChatComposerDocument(flow.editor, chatComposerDocumentToUserContent({ type: 'doc', attrs: { panelResourceIds: ['panel'], quotes: [quote] }, content: [{ type: 'paragraph', content: [
      { type: 'text', text: `${prefix} inspect <Policy> & keep notes ` },
      { type: 'chatResourceReference', attrs: { resourceId: 'inline' } },
      { type: 'chatPromptDirective', attrs: { directive: 'skill', value: 'writer', skill } },
    ] }] }))
    flow.editor.commands.setTextSelection(prefix.length + 1)
    flow.composer.activeTrigger.value = { kind: 'slash', query: 'rev' }
    flow.composer.selectSuggestion({ kind: 'slashCommand', value: '/review', label: '/review', description: null, path: null })
    expect(flow.sent).toEqual([])
    flow.composer.submit()
    const content = flow.sentPayloads[0]?.userContent
    expect(flow.sentPayloads).toHaveLength(1)
    expect(flow.sent[0]).toContain('inspect <Policy> & keep notes')
    expect(content?.body[0]?.content).toEqual([
      { type: 'prompt_directive', directive: 'slash_command', commandMode: 'prompt', value: '/review' },
      { type: 'text', text: '  inspect <Policy> & keep notes ' },
      { type: 'resource_ref', resourceId: 'inline' },
      { type: 'prompt_directive', directive: 'skill', value: 'writer', skill },
    ])
    expect(content?.panelResourceIds).toEqual(['panel'])
    expect(content?.quotes).toEqual([quote])
  })

  it('opens the skills picker from suggestions without discarding the remaining input', async () => {
    const flow = await mountComposer()
    const prefix = '/ski'
    replaceChatComposerDocument(flow.editor, chatComposerDocumentToUserContent({ type: 'doc', attrs: { panelResourceIds: ['panel'] }, content: [{ type: 'paragraph', content: [
      { type: 'text', text: `${prefix} keep this text ` },
      { type: 'chatResourceReference', attrs: { resourceId: 'inline' } },
    ] }] }))
    flow.editor.commands.setTextSelection(prefix.length + 1)
    flow.composer.activeTrigger.value = { kind: 'slash', query: 'ski' }
    flow.composer.selectSuggestion({ kind: 'slashCommand', value: '/skills', label: '/skills', description: null, path: null })
    expect(flow.sent).toEqual([])
    expect(chatComposerDocumentToUserContent(flow.editor.getJSON())).toMatchObject({
      body: [{ content: [{ type: 'text', text: '$ keep this text ' }, { type: 'resource_ref', resourceId: 'inline' }] }],
      panelResourceIds: ['panel'],
    })
    expect(flow.editor.state.selection.from).toBe(2)
  })

  it('uses working-directory-relative navigation, keeps external paths absolute and resets deep search between mentions', async () => {
    const queries: Array<{ query: string | null, deep: boolean | undefined }> = []
    const folder = { ...fileOption('apps'), path: '/work/apps', entryKind: 'directory' as const }
    const flow = await mountComposer({ loadContextOptions: async (query, deep) => {
      queries.push({ query, deep })
      return { files: [folder], skills: [], directory: { workingDirectory: '/work', path: query?.startsWith('apps/') ? '/work/apps' : '/work', status: 'ready', hasMore: false } }
    } })
    flow.editor.view.dom.focus()
    flow.editor.commands.insertContent('@ap')
    await nextTick()
    flow.composer.setDeepSearch(true)
    await nextTick()
    expect(queries.at(-1)).toEqual({ query: 'ap', deep: true })
    flow.keydown('Tab')
    await nextTick()
    expect(flow.editor.getText()).toBe('@apps/')
    expect(flow.composer.deepSearch.value).toBe(true)
    expect(getChatComposerResourceIds(flow.editor.getJSON())).toEqual([])
    flow.keydown('ArrowLeft', { altKey: true })
    await nextTick()
    expect(flow.editor.getText()).toBe('@')
    flow.composer.navigateDirectory('/downloads/media folder')
    await nextTick()
    expect(flow.editor.getText()).toBe('@"/downloads/media folder/')
    flow.keydown('Escape')
    expect(flow.composer.deepSearch.value).toBe(false)
    flow.editor.commands.insertContent('" @')
    await nextTick()
    expect(queries.at(-1)).toEqual({ query: '', deep: false })
    expect(flow.sent).toEqual([])
  })

  it('does not accept a late deep-search response after switching back to direct browsing', async () => {
    const deep = deferred<ChatComposerContextOptions>()
    const flow = await mountComposer({ loadContextOptions: (_query, recursive) => recursive ? deep.promise : Promise.resolve({ files: [fileOption('direct')], skills: [] }) })
    flow.editor.view.dom.focus()
    flow.editor.commands.insertContent('@')
    await nextTick()
    flow.composer.setDeepSearch(true)
    flow.composer.setDeepSearch(false)
    await nextTick()
    deep.resolve({ files: [fileOption('nested')], skills: [] })
    await nextTick()
    expect(flow.composer.suggestions.value.map(item => item.option.label)).toEqual(['direct'])
  })

  it('shares clipboard image labels across @ candidates, repeated references and removal', async () => {
    const flow = await mountComposer()
    const resource = { draftId: 'draft-1', kind: 'image' as const, mimeType: 'image/png', name: 'image.png', nameSource: 'clipboard' as const, previewUrl: null, sizeBytes: 10, state: 'ready' as const }
    flow.resources.value = ['second', 'first'].map(resourceId => ({ accepted: true, canRetry: false, resource: { ...resource, attachmentId: resourceId, resourceId } }))
    insertChatComposerResources(flow.editor, ['first', 'second'], 'both')
    flow.editor.view.dom.focus()
    flow.editor.commands.insertContent('@')
    const candidates = () => flow.composer.suggestions.value.map(({ option }) => [option.value, option.label])
    const inlineLabels = () => [...flow.editor.view.dom.querySelectorAll('[data-type="chat-resource-reference"]')].map(element => element.textContent)
    await expect.poll(candidates).toEqual([['first', '[Image #1]'], ['second', '[Image #2]']])
    expect(inlineLabels()).toEqual(['[Image #1]', '[Image #2]'])
    flow.keydown('ArrowDown')
    flow.keydown('Enter')
    await expect.poll(inlineLabels).toEqual(['[Image #1]', '[Image #2]', '[Image #2]'])
    expect(getChatComposerResourceIds(flow.editor.getJSON())).toEqual(['first', 'second'])

    flow.editor.commands.insertContent('@image.png')
    await expect.poll(candidates).toEqual([['first', '[Image #1]'], ['second', '[Image #2]']])
    flow.keydown('Escape')
    flow.composer.removeResource('first')
    await expect.poll(inlineLabels).toEqual(['[Image #1]', '[Image #1]'])
    flow.editor.commands.insertContent(' @#1')
    await expect.poll(candidates).toEqual([['second', '[Image #1]']])
    expect(flow.composer.materials.value.flatMap(entry => entry.kind === 'resource' ? [entry.imageLabel] : [])).toEqual(['[Image #1]'])
    expect(flow.sent).toEqual([])
  })

  it('reuses a current input through @ without reimporting, and excludes removed or other-draft resources', async () => {
    const flow = await mountComposer({ selectSource: async () => {
      throw new Error('Current inputs must reuse their existing resource')
    } })
    const resource = { attachmentId: 'image-copy', draftId: 'draft-1', kind: 'image' as const, mimeType: 'image/png', name: 'current.png', previewUrl: null, resourceId: 'current', sizeBytes: 10, state: 'ready' as const }
    flow.resources.value = [resource, { ...resource, resourceId: 'removed', name: 'removed.png' }, { ...resource, draftId: 'draft-other', resourceId: 'other', name: 'other.png' }].map(resource => ({ accepted: true, canRetry: false, resource }))
    insertChatComposerResources(flow.editor, ['current'], 'panel')
    flow.editor.view.dom.focus()
    flow.editor.commands.insertContent('@current')
    await expect.poll(() => flow.composer.suggestions.value.map(item => item.option.label)).toEqual(['current.png'])
    flow.keydown('Enter')
    await expect.poll(() => flow.editor.view.dom.querySelectorAll('[data-type="chat-resource-reference"]').length).toBe(1)
    expect(getChatComposerResourceIds(flow.editor.getJSON())).toEqual(['current'])
    flow.composer.removeResource('current')
    flow.editor.commands.insertContent('@')
    await expect.poll(() => flow.composer.suggestions.value).toEqual([])
    expect(flow.sent).toEqual([])
  })

  it('enters a directory with Tab, synchronizes a quoted path and selects a child with arrows and Enter', async () => {
    const folder = { ...fileOption('media folder'), path: '/workspace/media folder', entryKind: 'directory' as const }
    const children = Array.from({ length: 12 }, (_, index) => ({ ...fileOption(`file-${index}.txt`), path: `/workspace/media folder/file-${index}.txt` }))
    const queries: (string | null)[] = []
    const selections: BuddyComposerSource[] = []
    const flow = await mountComposer({ loadContextOptions: async (query) => {
      queries.push(query)
      return { files: query === '' ? [folder] : children, skills: [] }
    }, selectSource: async (source) => {
      selections.push(source)
      return 'chosen'
    } })
    flow.editor.view.dom.focus()
    flow.editor.commands.insertContent('@')
    await nextTick()
    expect(flow.keydown('Tab').defaultPrevented).toBe(true)
    await nextTick()
    expect(flow.editor.getText()).toBe('@"/workspace/media folder/')
    expect(queries).toContain('/workspace/media folder/')
    expect(getChatComposerResourceIds(flow.editor.getJSON())).toEqual([])
    for (let index = 0; index < 10; index++)
      flow.keydown('ArrowDown')
    flow.keydown('ArrowUp')
    flow.keydown('Enter')
    await nextTick()
    expect(selections).toEqual([children[9]!.source])
    await expect.poll(() => getChatComposerResourceIds(flow.editor.getJSON())).toEqual(['chosen'])
    expect(flow.sent).toEqual([])
  })

  it('selects a directory itself on Enter and does not pick stale results during a new query', async () => {
    const pending = deferred<ChatComposerContextOptions>()
    const folder = { ...fileOption('folder'), path: '/workspace/folder', entryKind: 'directory' as const }
    const selections: BuddyComposerSource[] = []
    const flow = await mountComposer({ loadContextOptions: query => query === '' ? Promise.resolve({ files: [folder], skills: [] }) : pending.promise, selectSource: async (source) => {
      selections.push(source)
      return 'folder-resource'
    } })
    flow.editor.view.dom.focus()
    flow.editor.commands.insertContent('@')
    await nextTick()
    flow.editor.commands.insertContent('new')
    flow.keydown('Enter')
    expect(selections).toEqual([])
    expect(flow.sent).toEqual([])
    pending.resolve({ files: [folder], skills: [] })
    await nextTick()
    await expect.poll(() => flow.composer.suggestions.value.length).toBe(1)
    flow.keydown('Enter')
    await nextTick()
    await expect.poll(() => getChatComposerResourceIds(flow.editor.getJSON())).toEqual(['folder-resource'])
    expect(flow.sent).toEqual([])
  })
  it('retains unsupported saved model settings and blocks submission until the user selects supported values', async () => {
    const flow = await mountComposer({
      model: {
        available: true,
        type: 'chat',
        sourceType: 'chat',
        typeOverride: null,
        catalogMatch: 'not_applicable',
        catalog: { source: null, selection: null, candidates: [] },
        metadataKnown: true,
        capabilityOverrides: null,
        fileInputMimeTypes: [],
        sourceCapabilities: { image: false, reasoningOptions: ['low'] },
        api: 'openai-completions',
        capabilities: ['text'],
        contextWindow: 128_000,
        displayName: 'Fixture',
        enabled: true,
        hasParameterOverride: false,
        lastSeenAt: null,
        maxTokens: 4_096,
        modelId: 'fixture',
        overrideContextWindow: null,
        overrideMaxTokens: null,
        providerId: 'fixture',
        reasoningOptions: ['low'],
        serviceTiers: [],
        source: 'builtin',
        sourceContextWindow: 128_000,
        sourceMaxTokens: 4_096,
        sourceParametersUpdated: false,
      },
    })
    flow.editor.commands.insertContent('saved draft')
    flow.selectedEffort.value = 'high'
    flow.selectedServiceTier.value = 'priority'
    flow.composer.submit()
    expect(flow.composer.modelInputIssue.value).toBe('reasoning_unsupported')
    expect(flow.composer.canSubmit.value).toBe(false)
    expect(flow.sent).toEqual([])
    expect(flow.selectedEffort.value).toBe('high')
    expect(flow.selectedServiceTier.value).toBe('priority')

    flow.selectedEffort.value = 'low'
    expect(flow.composer.modelInputIssue.value).toBe('service_tier_unsupported')
    flow.composer.submit()
    expect(flow.sent).toEqual([])

    flow.selectedServiceTier.value = null
    expect(flow.composer.modelInputIssue.value).toBeNull()
    expect(flow.composer.canSubmit.value).toBe(true)
    flow.composer.submit()
    expect(flow.sent).toEqual(['saved draft'])
  })

  it('preserves selection and undo when canonical content returns', async () => {
    const flow = await mountComposer()
    flow.editor.commands.insertContent('first draft')
    const selection = flow.editor.state.selection.toJSON()
    await nextTick()

    expect(flow.editor.state.selection.toJSON()).toEqual(selection)

    flow.editor.commands.undo()
    await nextTick()
    expect(flow.editor.getText()).toBe('')
    expect(flow.draft.value).toBe('')
    flow.editor.commands.redo()
    await nextTick()
    expect(flow.draft.value).toBe('first draft')
  })

  it('switches to an external draft and resumes saving local edits', async () => {
    const flow = await mountComposer()
    flow.editor.commands.insertContent('local')
    await nextTick()
    flow.draftId.value = 'draft-2'
    flow.draft.value = 'restored'
    flow.content.value = createChatComposerContentFromText('restored')
    await nextTick()

    expect(flow.editor.getText()).toBe('restored')
    flow.editor.commands.insertContentAt(9, ' text')
    await nextTick()
    expect(flow.draft.value).toBe('restored text')
  })

  it('does not submit or expose suggestions during IME composition and restores the trigger afterward', async () => {
    const flow = await mountComposer()
    flow.editor.view.dom.focus()
    flow.editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    flow.editor.commands.insertContent('@notes')
    await nextTick()
    expect(flow.composer.activeTrigger.value).toBeNull()
    flow.keydown('Enter', { isComposing: true })
    expect(flow.sent).toEqual([])
    expect(flow.editor.getText()).toBe('@notes')

    flow.editor.view.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    await nextTick()
    expect(flow.composer.activeTrigger.value).toEqual({ kind: 'mention', query: 'notes' })
  })

  it('inserts a line break with Shift Enter and submits with Enter', async () => {
    const flow = await mountComposer()
    flow.editor.commands.insertContent('notes')
    flow.keydown('Enter', { shiftKey: true })
    expect(flow.editor.getJSON().content?.[0]?.content?.at(-1)?.type).toBe('hardBreak')
    expect(flow.sent).toEqual([])
    flow.keydown('Enter')
    expect(flow.sent).toEqual(['notes'])
  })

  it('keeps an empty mention active and prevents Enter from accidentally submitting until it is dismissed', async () => {
    const pending = deferred<ChatComposerContextOptions>()
    const flow = await mountComposer({ loadContextOptions: () => pending.promise })
    flow.editor.view.dom.focus()
    flow.editor.commands.insertContent('@')
    await nextTick()
    expect(flow.keydown('Enter').defaultPrevented).toBe(true)
    expect(flow.sent).toEqual([])
    pending.resolve({ files: [], skills: [] })
    await nextTick()
    await nextTick()
    expect(flow.composer.isLoadingContext.value).toBe(false)
    expect(flow.composer.activeTrigger.value).toEqual({ kind: 'mention', query: '' })
    flow.keydown('Enter')
    expect(flow.sent).toEqual([])
    flow.keydown('Escape')
    expect(flow.composer.activeTrigger.value).toBeNull()
    expect(flow.editor.getText()).toBe('@')
    flow.keydown('Enter')
    expect(flow.sent).toEqual(['@'])
  })

  it('keeps the latest query results when earlier requests fail and invalidates queries across drafts', async () => {
    const old = deferred<ChatComposerContextOptions>()
    const latest = deferred<ChatComposerContextOptions>()
    const leaving = deferred<ChatComposerContextOptions>()
    const requests = [old, latest, leaving]
    const flow = await mountComposer({ loadContextOptions: () => requests.shift()!.promise })
    const oldRequest = flow.composer.loadContextOptions('old')
    const latestRequest = flow.composer.loadContextOptions('latest')
    latest.resolve({ files: [fileOption('latest.txt')], skills: [] })
    await latestRequest
    old.reject(new Error('Old query failed'))
    await oldRequest
    expect(flow.composer.sourceOptions.value.map(option => option.label)).toEqual(['latest.txt'])
    expect(flow.composer.isLoadingContext.value).toBe(false)

    const leavingRequest = flow.composer.loadContextOptions('leaving')
    flow.draftId.value = 'draft-2'
    leaving.resolve({ files: [fileOption('old-draft.txt')], skills: [] })
    await leavingRequest
    expect(flow.composer.sourceOptions.value).toEqual([])
    expect(flow.composer.isLoadingContext.value).toBe(false)
  })

  it.each(['panel', 'inline'] as const)('does not insert a pending %s source after leaving and returning to the original draft', async (placement) => {
    const selecting = deferred<string | null>()
    const flow = await mountComposer({ selectSource: () => selecting.promise })
    flow.editor.commands.insertContent('@notes')
    flow.composer.activeTrigger.value = { kind: 'mention', query: 'notes' }
    const selected = placement === 'panel'
      ? flow.composer.selectPanelSource(fileOption('notes.txt'))
      : flow.composer.selectSuggestion(fileOption('notes.txt'))
    flow.draftId.value = 'draft-2'
    flow.draftId.value = 'draft-1'
    selecting.resolve('resource-1')
    await selected
    await nextTick()

    expect(getChatComposerResourceIds(flow.editor.getJSON())).toEqual([])
    expect(flow.editor.getText()).toBe('@notes')
  })
})

function localCommands(execute: WorkbenchCommandPort['execute']) {
  const errors: string[] = []
  const entries = shallowRef([{ id: 'tests.game.start', name: 'game:start', title: 'Start game' }])
  return { errors, entries, execute, reportFailure: () => {
    errors.push('failed')
  } }
}

it('inserts a stable local command reference without executing, then runs without a model', async () => {
  const executions: { id: string, args: string }[] = []
  const commands = localCommands(async (id, args) => {
    executions.push({ id, args })
    return null
  })
  const flow = await mountComposer({ commands })
  flow.canSend.value = false
  flow.editor.commands.setContent(createChatComposerContentFromText('/game:star'))
  flow.editor.commands.setTextSelection('/game:star'.length + 1)
  flow.composer.activeTrigger.value = { kind: 'slash', query: 'game:star' }
  flow.composer.selectSuggestion({ kind: 'slashCommand', commandId: 'tests.game.start', value: '/game:start', label: '/game:start', description: null, path: null })
  expect(executions).toEqual([])
  expect(chatComposerDocumentToUserContent(flow.editor.getJSON()).body[0]!.content[0]).toMatchObject({ commandId: 'tests.game.start', value: '/game:start', commandMode: 'action' })
  flow.editor.commands.insertContent('level=2')
  expect(flow.composer.canSubmit.value).toBe(true)
  flow.keydown('Enter')
  await nextTick()
  expect(executions).toEqual([{ id: 'tests.game.start', args: 'level=2' }])
  expect(flow.sent).toEqual([])
  expect(flow.editor.getText()).toBe('')
})

it.each(['/GAME:start', '/game:started'])('keeps an unmatched local command %s out of the model path', async (text) => {
  let executed = false
  const commands = localCommands(async () => {
    executed = true
    return null
  })
  const flow = await mountComposer({ commands })
  flow.editor.commands.setContent(createChatComposerContentFromText(text))
  flow.keydown('Enter')
  await nextTick()
  expect(flow.editor.getText()).toBe(text)
  expect(flow.sent).toEqual([])
  expect(executed).toBe(false)
  expect(commands.errors).toEqual(['failed'])
})

it('retains a failed or removed command draft and never dispatches it as a prompt', async () => {
  const commands = localCommands(async () => {
    throw new Error('Unavailable')
  })
  const flow = await mountComposer({ commands })
  flow.editor.commands.setContent(createChatComposerContentFromText('/game:start'))
  flow.keydown('Enter')
  await nextTick()
  expect(flow.editor.getText()).toBe('/game:start')
  commands.entries.value = []
  flow.keydown('Enter')
  await nextTick()
  expect(flow.editor.getText()).toBe('/game:start')
  expect(commands.errors).toEqual(['failed', 'failed'])
  expect(flow.sent).toEqual([])
})

it('does not restore a failed command over newer input', async () => {
  const result = deferred<null>()
  const flow = await mountComposer({ commands: localCommands(() => result.promise) })
  flow.editor.commands.setContent(createChatComposerContentFromText('/game:start'))
  flow.keydown('Enter')
  expect(flow.editor.getText()).toBe('')
  flow.editor.commands.setContent(createChatComposerContentFromText('New work'))
  result.reject(new Error('Unavailable'))
  await nextTick()
  expect(flow.editor.getText()).toBe('New work')
  expect(flow.sent).toEqual([])
})

it('offers every same-name command and preserves arguments after leading paragraphs, hard breaks and spaces', async () => {
  const prefix = ' \n\n  '
  const executions: { id: string, args: string }[] = []
  const commands = localCommands(async (id, args) => {
    executions.push({ id, args })
    return null
  })
  commands.entries.value = Array.from({ length: 10 }, (_, index) => ({ id: `author${index}.game.start`, name: 'game:start', title: `Game ${index}` }))
  const flow = await mountComposer({ commands })
  const initial = createChatComposerContentFromText(`${prefix}/game:start level=2`)
  initial.content!.at(-1)!.content!.unshift({ type: 'hardBreak' })
  flow.editor.commands.setContent(initial)
  const before = flow.editor.getJSON()
  flow.composer.submit()
  await nextTick()
  expect(flow.editor.getJSON()).toEqual(before)
  expect(flow.composer.suggestions.value).toHaveLength(10)
  flow.keydown('Enter')
  expect(executions).toEqual([])
  flow.composer.selectSuggestion(flow.composer.suggestions.value[9]!.option)
  const { body } = chatComposerDocumentToUserContent(flow.editor.getJSON())
  expect(body.slice(0, -1)).toEqual(chatComposerDocumentToUserContent(before).body.slice(0, -1))
  const leadingSpace = prefix.split('\n').at(-1)!
  expect(body.at(-1)!.content).toEqual([
    { type: 'hard_break' },
    ...leadingSpace ? [{ type: 'text', text: leadingSpace }] : [],
    { type: 'prompt_directive', directive: 'slash_command', commandMode: 'action', commandId: 'author9.game.start', value: '/game:start' },
    { type: 'text', text: '  level=2' },
  ])
  flow.composer.submit()
  await nextTick()
  expect(executions).toEqual([{ id: 'author9.game.start', args: 'level=2' }])
  expect(flow.sent).toEqual([])
  expect(commands.errors).toEqual([])
})

it('does not retarget a selected command when its plugin is removed', async () => {
  const executions: string[] = []
  const commands = localCommands(async (id) => {
    executions.push(id)
    return null
  })
  commands.entries.value.push({ id: 'other.game.start', name: 'game:start', title: 'Another game' })
  const flow = await mountComposer({ commands })
  flow.editor.commands.setContent(createChatComposerContentFromText('/game:start keep'))
  flow.composer.submit()
  await nextTick()
  flow.composer.selectSuggestion(flow.composer.suggestions.value[1]!.option)
  commands.entries.value = commands.entries.value.slice(0, 1)
  const before = flow.editor.getJSON()
  flow.composer.submit()
  await nextTick()
  expect(executions).toEqual([])
  expect(flow.editor.getJSON()).toEqual(before)
  expect(commands.errors).toEqual(['failed'])
})

it('browses session groups with Tab, returns with Alt Left, and inserts a reference into the original sentence', async () => {
  const group: ChatPromptContextOption = { kind: 'sessionGroup', category: 'sessions', label: '独立任务', description: null, path: null, value: 'sessions:', sessionScope: { spaceId: null, title: '独立任务' } }
  const reference: ChatPromptContextOption = { kind: 'sessionReference', category: 'sessions', label: '订单讨论', description: null, path: null, value: 'order', sessionReference: { id: 'order', title: '订单讨论' } }
  const flow = await mountComposer({ loadContextOptions: async (_query, _deep, scope) => ({ files: [], skills: [], sessions: scope ? [reference] : [group] }) })
  flow.editor.view.dom.focus()
  flow.editor.commands.insertContent('参考 @')
  await nextTick()
  await nextTick()
  expect(flow.composer.suggestions.value[0]?.option.kind).toBe('sessionGroup')
  flow.keydown('Tab')
  await nextTick()
  await nextTick()
  expect(flow.composer.sessionScope.value?.spaceId).toBeNull()
  expect(flow.composer.suggestions.value[0]?.option.kind).toBe('sessionReference')
  flow.keydown('Tab', { shiftKey: true })
  expect(flow.composer.sessionScope.value?.spaceId).toBeNull()
  flow.keydown('ArrowLeft', { altKey: true, isComposing: true })
  expect(flow.composer.sessionScope.value?.spaceId).toBeNull()
  flow.keydown('ArrowLeft', { altKey: true })
  await nextTick()
  await nextTick()
  expect(flow.composer.sessionScope.value).toBeUndefined()
  flow.keydown('Tab')
  await nextTick()
  await nextTick()
  flow.keydown('Enter')
  flow.editor.commands.insertContent(' 的决定继续。')
  expect(flow.editor.getText()).toBe('参考 @订单讨论 的决定继续。')
  expect(chatComposerDocumentToUserContent(flow.editor.getJSON()).sessionReferences).toEqual([reference.sessionReference])
  expect(flow.sentPayloads).toEqual([])
})
