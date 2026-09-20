// @vitest-environment jsdom
import type { BuddyComposerSource } from '@buddy-shared/conversation/composerResource'
import type { BuddyServiceTier, BuddyThinkingLevel } from '@buddy-shared/conversation/modelSelection'
import type { LocalRuntimeModelOption } from '@buddy-shared/providers/providerApi'
import type { JSONContent } from '@tiptap/core'
import type { ComposerResourceView } from '../../../state/composer/typing'
import type { ChatComposerContextOptions, ChatComposerSubmitPayload, ChatPromptContextOption } from '@/modules/prompt-input'
import { deferred } from '@buddy-tests/deferred'
import { EditorContent } from '@tiptap/vue-3'
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, defineComponent, h, nextTick, shallowRef } from 'vue'
import { chatComposerDocumentToUserContent, createChatComposerContentFromText, getChatComposerResourceIds } from '@/modules/prompt-input'
import { replaceChatComposerDocument } from '@/modules/prompt-input/editor/chatComposerResourceEditing'
import { insertChatComposerResources } from '@/modules/prompt-input/ui'
import { useChatComposer } from '../useChatComposer'

const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).forEach(cleanup => cleanup()))

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
  loadContextOptions?: (query: string | null, deepSearch?: boolean) => Promise<ChatComposerContextOptions>
  selectSource?: (source: BuddyComposerSource) => Promise<string | null>
  model?: LocalRuntimeModelOption
} = {}) {
  const content = shallowRef(createChatComposerContentFromText(''))
  const draft = shallowRef('')
  const draftId = shallowRef('draft-1')
  const resources = shallowRef<readonly ComposerResourceView[]>([])
  const selectedEffort = shallowRef<BuddyThinkingLevel | null>(null)
  const selectedServiceTier = shallowRef<BuddyServiceTier | null>(null)
  const updates: { text: string, content: JSONContent }[] = []
  const sent: string[] = []
  const sentPayloads: ChatComposerSubmitPayload[] = []
  let composer!: ReturnType<typeof useChatComposer>
  const root = document.createElement('div')
  document.body.append(root)
  const app = createApp(defineComponent({
    setup() {
      composer = useChatComposer({
        canSend: shallowRef(true),
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
        selectSource: options.selectSource ?? (async () => null),
        onSend: (payload) => {
          sent.push(payload.content)
          sentPayloads.push(payload)
        },
        onUpdateContent: (text, value) => {
          updates.push({ text, content: value })
          draft.value = text
          content.value = value
        },
      })
      return () => h(EditorContent, { editor: composer.editor.value })
    },
  }))
  app.mount(root)
  await nextTick()
  await nextTick()
  let mounted = true
  function unmount() {
    if (!mounted)
      return
    mounted = false
    app.unmount()
    root.remove()
  }
  cleanups.push(unmount)
  const editor = composer.editor.value!
  function keydown(key: string, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...init })
    editor.view.dom.dispatchEvent(event)
    return event
  }
  return { composer, content, draft, draftId, editor, keydown, resources, selectedEffort, selectedServiceTier, sent, sentPayloads, updates, unmount }
}

describe('chat composer editing', () => {
  it.each(['select', 'submit'] as const)('preserves structured input when a review command is handled through %s', async (source) => {
    const flow = await mountComposer()
    const prefix = source === 'select' ? '/rev' : '/review'
    const skill = { id: 'writer-id', name: 'writer', revision: 'revision-one' }
    const quote = { id: 'quote', text: 'quoted evidence', source: { conversationId: 'conversation', branchId: 'branch', messageId: 'message', role: 'assistant', runId: 'run' } }
    flow.resources.value = ['inline', 'panel'].map(resourceId => ({ accepted: true, canRetry: false, resource: { draftId: 'draft-1', resourceId, kind: 'text', mimeType: 'text/plain', name: `${resourceId}.txt`, sizeBytes: 10, state: 'ready', attachmentId: resourceId, previewUrl: null } }))
    replaceChatComposerDocument(flow.editor, chatComposerDocumentToUserContent({ type: 'doc', attrs: { panelResourceIds: ['panel'], quotes: [quote] }, content: [{ type: 'paragraph', content: [
      { type: 'text', text: `${prefix} inspect <Policy> & keep notes ` },
      { type: 'chatResourceReference', attrs: { resourceId: 'inline' } },
      { type: 'chatPromptDirective', attrs: { directive: 'skill', value: 'writer', skill } },
    ] }] }))
    if (source === 'select') {
      flow.editor.commands.setTextSelection(prefix.length + 1)
      flow.composer.activeTrigger.value = { kind: 'slash', query: 'rev' }
      flow.composer.selectSuggestion({ kind: 'slashCommand', value: '/review', label: '/review', description: null, path: null })
      expect(flow.sent).toEqual([])
    }
    flow.composer.submit()
    const content = flow.sentPayloads[0]?.userContent
    expect(flow.sentPayloads).toHaveLength(1)
    expect(flow.sent[0]).toContain('inspect <Policy> & keep notes')
    expect(content?.body[0]?.content).toEqual([
      { type: 'prompt_directive', directive: 'slash_command', commandMode: 'prompt', value: '/review' },
      { type: 'text', text: `${source === 'select' ? ' ' : ''} inspect <Policy> & keep notes ` },
      { type: 'resource_ref', resourceId: 'inline' },
      { type: 'prompt_directive', directive: 'skill', value: 'writer', skill },
    ])
    expect(content?.panelResourceIds).toEqual(['panel'])
    expect(content?.quotes).toEqual([quote])
  })

  it.each(['select', 'submit'] as const)('opens the skills picker without discarding the remaining input through %s', async (source) => {
    const flow = await mountComposer()
    const prefix = source === 'select' ? '/ski' : '/skills'
    replaceChatComposerDocument(flow.editor, chatComposerDocumentToUserContent({ type: 'doc', attrs: { panelResourceIds: ['panel'] }, content: [{ type: 'paragraph', content: [
      { type: 'text', text: `${prefix} keep this text ` },
      { type: 'chatResourceReference', attrs: { resourceId: 'inline' } },
    ] }] }))
    if (source === 'select') {
      flow.editor.commands.setTextSelection(prefix.length + 1)
      flow.composer.activeTrigger.value = { kind: 'slash', query: 'ski' }
      flow.composer.selectSuggestion({ kind: 'slashCommand', value: '/skills', label: '/skills', description: null, path: null })
    }
    else {
      flow.composer.submit()
    }
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
    flow.keydown('Tab', { shiftKey: true })
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
    expect(flow.composer.resourceStripResources.value.map(entry => entry.imageLabel)).toEqual(['[Image #1]'])
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

  it('echoes local transactions once and preserves selection and undo when canonical content returns', async () => {
    const flow = await mountComposer()
    flow.editor.commands.insertContent('first draft')
    const selection = flow.editor.state.selection.toJSON()
    await nextTick()

    expect(flow.updates.map(update => update.text)).toEqual(['first draft'])
    expect(flow.content.value).toEqual(flow.editor.getJSON())
    expect(flow.editor.state.selection.toJSON()).toEqual(selection)

    flow.editor.commands.undo()
    await nextTick()
    expect(flow.editor.getText()).toBe('')
    expect(flow.draft.value).toBe('')
    flow.editor.commands.redo()
    await nextTick()
    expect(flow.draft.value).toBe('first draft')
  })

  it('hydrates an external draft without emitting it back and resumes local transaction updates', async () => {
    const flow = await mountComposer()
    flow.editor.commands.insertContent('local')
    await nextTick()
    flow.draftId.value = 'draft-2'
    flow.draft.value = 'restored'
    flow.content.value = createChatComposerContentFromText('restored')
    await nextTick()

    expect(flow.editor.getText()).toBe('restored')
    expect(flow.updates.map(update => update.text)).toEqual(['local'])
    flow.editor.commands.insertContentAt(9, ' text')
    await nextTick()
    expect(flow.draft.value).toBe('restored text')
    expect(flow.updates.map(update => update.text)).toEqual(['local', 'restored text'])
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

  it('maps a pending inline source through later typing in the same draft without moving the selection', async () => {
    const selecting = deferred<string | null>()
    const flow = await mountComposer({ selectSource: () => selecting.promise })
    flow.editor.commands.insertContent('@notes')
    flow.composer.activeTrigger.value = { kind: 'mention', query: 'notes' }
    flow.composer.selectSuggestion(fileOption('notes.txt'))
    flow.editor.commands.insertContentAt(1, 'before ')
    flow.editor.commands.setTextSelection(flow.editor.state.doc.content.size - 1)
    flow.editor.commands.insertContent(' after')
    selecting.resolve('resource-1')
    await nextTick()
    await nextTick()

    expect(getChatComposerResourceIds(flow.editor.getJSON())).toEqual(['resource-1'])
    expect(flow.editor.getText()).toContain('before ')
    expect(flow.editor.getText()).toContain(' after')
    expect(flow.editor.state.selection.from).toBe(flow.editor.state.doc.content.size - 1)
  })

  it('ranks skill name matches above description matches and loads the skill catalog once per suggestion session', async () => {
    const queries: (string | null)[] = []
    const flow = await mountComposer({ loadContextOptions: async (query) => {
      queries.push(query)
      return {
        files: [],
        skills: [
          skillOption('antfu', 'opinionated tooling for projects'),
          skillOption('pr', 'create a pull request'),
          skillOption('grill-me', 'planning interviews'),
          skillOption('snapshot-approval', 'approve snapshots'),
        ],
      }
    } })
    const skillLabels = () => flow.composer.suggestions.value.map(item => item.option.label)
    flow.editor.view.dom.focus()
    flow.editor.commands.insertContent('$')
    await expect.poll(skillLabels).toEqual(['antfu', 'pr', 'grill-me', 'snapshot-approval'])
    flow.editor.commands.insertContent('pr')
    await expect.poll(skillLabels).toEqual(['pr', 'snapshot-approval', 'antfu'])
    expect(queries).toEqual([null])

    flow.keydown('Escape')
    expect(flow.composer.activeTrigger.value).toBeNull()
    flow.editor.commands.insertContent(' $')
    await expect.poll(skillLabels).toEqual(['antfu', 'pr', 'grill-me', 'snapshot-approval'])
    expect(queries).toEqual([null, null])
    expect(flow.sent).toEqual([])
  })

  it('discards query results after the editor scope is disposed', async () => {
    const pending = deferred<ChatComposerContextOptions>()
    const flow = await mountComposer({ loadContextOptions: () => pending.promise })
    const loading = flow.composer.loadContextOptions('notes')
    flow.unmount()
    pending.resolve({ files: [fileOption('notes.txt')], skills: [] })
    await loading
    expect(flow.composer.sourceOptions.value).toEqual([])
    expect(flow.composer.isLoadingContext.value).toBe(false)
  })
})
