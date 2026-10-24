import type { ExtensionAPI, ExtensionToolContext, ToolCallEvent, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { BuddyMessageQuote, BuddyResourceQuote } from '../../../../shared/conversation/buddyUserContent'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { browserQuote } from '../../../../shared/browser/__tests__/browserSelectionFixture'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { toolCatalogId } from '../../agent/extensions/discovery/toolCatalog'
import { createChatQueueRepository } from '../../storage/chatQueueRepository'
import { createComposerDraftRepository } from '../../storage/composerDraftRepository'
import { createConversationHistoryStore } from '../../storage/conversationHistoryRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createExtensionReferenceRepository } from '../../storage/extensionReferenceRepository'
import { createRunRepository } from '../../storage/runRepository'
import { ReferenceSnapshotAccess } from '../ReferenceSnapshotAccess'
import { createReferenceSnapshotCapability } from '../referenceSnapshotExtension'
import { canReadReferenceSnapshots, REFERENCE_TOOL_SOURCE, REFERENCE_TOOLS } from '../referenceSnapshotToolContract'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0))
    await cleanup()
})

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'reference-snapshots-'))
  const path = join(directory, 'buddy.sqlite')
  let database = openBuddyDatabase({ databasePath: path })
  cleanups.push(async () => {
    database.close()
    await rm(directory, { recursive: true, force: true })
  })
  let conversations = createConversationRepository(database)
  for (const id of ['task', 'other'])
    conversations.create({ id, branchId: `${id}-branch`, title: id, spaceId: null, approvalPolicy: 'policy', executionProfile: 'read_only', createdAt: '2026-10-24T00:00:00.000Z' })
  let sequence = 0
  let currentRunId: string | undefined
  const controller = new AbortController()
  function message(resourceQuotes: BuddyResourceQuote[] = [], options: { quotes?: BuddyMessageQuote[], conversationId?: string, branchId?: string, role?: 'user' | 'assistant' | 'tool', runId?: string } = {}) {
    const conversationId = options.conversationId ?? 'task'
    return conversations.createMessage({ id: `message-${++sequence}`, conversationId, branchId: options.branchId ?? `${conversationId}-branch`, runId: options.runId ?? null, role: options.role ?? 'user', createdAt: new Date(Date.UTC(2026, 9, 24, 0, 0, sequence)).toISOString(), content: { resourceSnapshots: [], userContent: { ...createBuddyUserContent('Use saved references'), quotes: options.quotes ?? [], resourceQuotes } } })
  }
  function run(input: ReturnType<typeof message>, options: { parentRunId?: string, kind?: 'actor_child' | 'npc_child', activate?: boolean } = {}) {
    const id = `run-${++sequence}`
    createRunRepository(database).create({ id, conversationId: input.conversationId, branchId: input.branchId, triggeringMessageId: input.id, provider: 'fixture', model: 'fixture', purpose: 'chat', status: 'running', piSessionFile: null, approvalPolicy: 'policy', executionProfile: 'read_only', startedAt: input.createdAt, ...options.parentRunId ? { parentRunId: options.parentRunId, rootRunId: options.parentRunId, executionKind: options.kind ?? 'npc_child' } : {} })
    if (options.activate !== false)
      currentRunId = id
    return id
  }
  function options() {
    return { conversationId: 'task', getRunId: () => currentRunId, references: createExtensionReferenceRepository(database, createConversationHistoryStore(database).lineage), signal: controller.signal }
  }
  function access() {
    return new ReferenceSnapshotAccess(options())
  }
  function reopen() {
    database.close()
    database = openBuddyDatabase({ databasePath: path })
    conversations = createConversationRepository(database)
    return access()
  }
  function view(id = 'reference', text = 'Frozen original'): BuddyResourceQuote {
    return { id, text, source: { kind: 'view', title: 'Office', provider: 'extension:tests.office', target: { secret: 'private-target' } }, locator: { version: 1, data: { documentId: 'private-document' } } }
  }
  return {
    get database() { return database },
    get conversations() { return conversations },
    controller,
    message,
    run,
    options,
    access,
    reopen,
    view,
    setRun: (id: string) => { currentRunId = id },
  }
}

describe('saved reference access', () => {
  it('uses the same identities as role tool selection without bypassing explicit restrictions', () => {
    const ids = Object.values(REFERENCE_TOOLS).map(tool => toolCatalogId(REFERENCE_TOOL_SOURCE, tool))
    expect(canReadReferenceSnapshots({ mode: 'all' })).toBe(true)
    expect(canReadReferenceSnapshots({ mode: 'selected', ids })).toBe(true)
    expect(canReadReferenceSnapshots({ mode: 'selected', ids: ids.slice(0, 1) })).toBe(false)
    expect(canReadReferenceSnapshots({ mode: 'none' })).toBe(false)
  })
  it('pages all snapshot kinds by message and reference kind without exposing locator or view targets', async () => {
    const f = await fixture()
    const quote: BuddyMessageQuote = { id: 'same', text: 'Quoted answer', source: { conversationId: 'old', branchId: 'old-branch', messageId: 'old-message', role: 'assistant', runId: null } }
    const input = f.message([f.view('same'), browserQuote, { id: 'artifact', text: 'Frozen code', source: { kind: 'artifact', title: 'Code', artifactId: 'artifact-id', conversationId: 'old', runId: 'old-run', path: '/source/code.ts', updatedAt: '2026-10-24T00:00:00.000Z', format: 'source' } }], { quotes: [quote] })
    f.run(input)
    const access = f.access()
    const first = access.list({ limit: 2 })
    const second = access.list({ offset: first.nextOffset!, limit: 2 })
    expect(first).toMatchObject({ total: 4, nextOffset: 2 })
    expect(second).toMatchObject({ total: 4, nextOffset: null })
    expect([...first.items, ...second.items].map(item => item.sourceKind)).toEqual(['message', 'view', 'browser', 'artifact'])
    expect(access.read({ referenceId: 'same', sourceMessageId: input.id, kind: 'message' }).text).toBe('Quoted answer')
    const resource = access.read({ referenceId: 'same', sourceMessageId: input.id, kind: 'resource' })
    expect(resource.text).toBe('Frozen original')
    expect(resource.source).toEqual({ title: 'Office', provider: 'extension:tests.office' })
    const browser = access.read({ referenceId: browserQuote.id, sourceMessageId: input.id, kind: 'resource' })
    expect(JSON.stringify([first, second, resource, browser])).not.toMatch(/private-document|private-target|backendNodeId|frameId/)
    expect(browser).toMatchObject({ element: { role: 'button', name: 'Submit' } })
  })

  it('reads exact original pages after reopening SQLite, independent of summaries and current source state', async () => {
    const f = await fixture()
    const text = '原始😀快照\n'.repeat(8000)
    const input = f.message([f.view('long', text)])
    f.run(input)
    const later = f.message([f.view('long', 'Changed snapshot')])
    f.run(later)
    const access = f.reopen()
    let offset: number | null = 0
    let result = ''
    while (offset !== null) {
      const page = access.read({ sourceMessageId: input.id, referenceId: 'long', kind: 'resource', offset, limit: 16000 })
      expect(page.totalLength).toBe(text.length)
      result += page.text
      offset = page.nextOffset
    }
    expect(result).toBe(text)
    expect(access.read({ sourceMessageId: later.id, referenceId: 'long', kind: 'resource' }).text).toBe('Changed snapshot')
    expect(access.read({ sourceMessageId: input.id, referenceId: 'long', kind: 'resource', offset: text.length })).toMatchObject({ text: '', nextOffset: null })
    expect(() => access.read({ sourceMessageId: input.id, referenceId: 'long', kind: 'resource', offset: text.length + 1 })).toThrow('REFERENCE_OFFSET_OUT_OF_RANGE')
  })

  it('limits reads to accepted inputs and ancestor history, excluding other tasks, hidden forks and synthetic child inputs', async () => {
    const f = await fixture()
    const ancestor = f.message([f.view('ancestor')])
    f.run(ancestor)
    const hidden = f.message([f.view('hidden')])
    f.run(hidden)
    f.conversations.createBranch({ id: 'fork', conversationId: 'task', parentBranchId: 'task-branch', forkedFromMessageId: ancestor.id, createdAt: '2026-10-24T00:10:00.000Z', activate: true })
    const accepted = f.message([f.view('accepted')], { branchId: 'fork' })
    const parent = f.run(accepted)
    const child = f.run(accepted, { parentRunId: parent })
    const privateInput = { id: 'private-input' }
    f.database.prepare(`INSERT INTO messages (id, conversation_id, branch_id, run_id, role, content_json, created_at)
      VALUES (?, 'task', 'fork', ?, 'user', ?, '2026-10-24T00:09:00.000Z')`)
      .run(privateInput.id, child, JSON.stringify({ resourceSnapshots: [], userContent: { ...createBuddyUserContent('Private'), resourceQuotes: [f.view('private')] } }))
    const other = f.message([f.view('other')], { conversationId: 'other' })
    f.run(other, { activate: false })
    const future = f.message([f.view('future')], { branchId: 'fork' })
    f.run(future, { activate: false })
    const access = f.access()
    expect(access.list({}).items.map(item => item.referenceId)).toEqual(['accepted', 'ancestor'])
    for (const [message, id] of [[hidden, 'hidden'], [privateInput, 'private'], [other, 'other'], [future, 'future']] as const)
      expect(() => access.read({ sourceMessageId: message.id, referenceId: id, kind: 'resource' })).toThrow('REFERENCE_NOT_AUTHORIZED')
  })

  it('advances root scope only when a queued input is accepted and keeps the existing child scope frozen', async () => {
    const f = await fixture()
    const input = f.message([f.view('initial')])
    const parent = f.run(input)
    const child = f.run(input, { parentRunId: parent })
    const drafts = createComposerDraftRepository(f.database)
    drafts.open({ draftId: 'draft', scope: { kind: 'global' }, initialContent: createBuddyUserContent(), initialModelSelection: null, initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'read_only' }, now: '2026-10-24T00:10:00.000Z' })
    const queue = createChatQueueRepository(f.database)
    queue.enqueue({ approvalPolicy: 'policy', executionProfile: 'read_only', attachmentBindings: [], branchId: 'task-branch', conversationId: 'task', createdAt: '2026-10-24T00:11:00.000Z', draft: { draftId: 'draft', expectedRevision: drafts.findById('draft')!.revision }, model: 'fixture', provider: 'fixture', requestId: 'request', requestFingerprint: 'fingerprint', runInput: { attachmentIds: [], contextItems: [], prompt: 'Queued', reasoning: null, serviceTier: null }, runId: 'queued-run', spaceId: null, title: 'task', userMessageId: 'queued-message', userMessageContent: { resourceSnapshots: [], userContent: { ...createBuddyUserContent('Queued'), resourceQuotes: [f.view('queued')] } } })
    f.setRun(parent)
    expect(f.access().list({}).items.map(item => item.referenceId)).toEqual(['initial'])
    queue.commitInRun(queue.pending({ conversationId: 'task', branchId: 'task-branch', id: 'queued-message' })!, parent, undefined)
    expect(f.access().list({}).items.map(item => item.referenceId)).toEqual(['queued', 'initial'])
    f.setRun(child)
    expect(f.access().list({}).items.map(item => item.referenceId)).toEqual(['initial'])
  })

  it.each(['delete', 'branch', 'cancel', 'finish', 'message deleted'])('revalidates %s after policy classification and before tool delivery', async (change) => {
    const f = await fixture()
    const input = f.message([f.view()])
    const runId = f.run(input)
    const capability = createReferenceSnapshotCapability(f.options())
    const tools = new Map<string, ToolDefinition>()
    await capability.extension.factory({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI)
    const args = { sourceMessageId: input.id, referenceId: 'reference', kind: 'resource' }
    expect(await capability.classify({ type: 'tool_call', toolName: REFERENCE_TOOLS.read.name, toolCallId: 'call', input: args } as ToolCallEvent, f.controller.signal)).toEqual({ access: 'read', paths: [] })
    if (change === 'delete')
      f.conversations.markDeleted('task', '2026-10-24T00:10:00.000Z')
    if (change === 'branch')
      f.conversations.createBranch({ id: 'changed-branch', conversationId: 'task', parentBranchId: null, forkedFromMessageId: null, createdAt: '2026-10-24T00:10:00.000Z', activate: true })
    if (change === 'cancel')
      f.controller.abort()
    if (change === 'finish')
      f.database.prepare('UPDATE runs SET status = \'completed\' WHERE id = ?').run(runId)
    if (change === 'message deleted')
      f.database.prepare('DELETE FROM messages WHERE id = ?').run(input.id)
    await expect(tools.get(REFERENCE_TOOLS.read.name)!.execute('call', args, f.controller.signal, undefined, {} as ExtensionToolContext)).rejects.toThrow()
  })

  it('rejects invalid identities and unbounded pagination at the tool boundary', async () => {
    const f = await fixture()
    const input = f.message([f.view()])
    f.run(input)
    const capability = createReferenceSnapshotCapability(f.options())
    const tools: ToolDefinition[] = []
    await capability.extension.factory({ registerTool: (tool: ToolDefinition) => tools.push(tool) } as unknown as ExtensionAPI)
    for (const args of [{ sourceMessageId: input.id, referenceId: 'reference' }, { sourceMessageId: input.id, referenceId: 'reference', kind: 'resource', limit: 16001 }, { sourceMessageId: input.id, referenceId: 'reference', kind: 'resource', offset: -1 }])
      await expect(tools.find(tool => tool.name === REFERENCE_TOOLS.read.name)!.execute('call', args, f.controller.signal, undefined, {} as ExtensionToolContext)).rejects.toThrow('VALIDATION_FAILED')
    await expect(tools.find(tool => tool.name === REFERENCE_TOOLS.read.name)!.execute('call', { sourceMessageId: input.id, referenceId: '1', kind: 'resource' }, f.controller.signal, undefined, {} as ExtensionToolContext)).rejects.toThrow('REFERENCE_NOT_AUTHORIZED')
  })
})
