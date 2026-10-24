import type { DatabaseSync } from 'node:sqlite'
import type { ExtensionInvocationScope } from '../../plugins/extensionAgentHandlers'
import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { extensionJsonSchema } from '../../../../shared/extensions/extensionApi'
import { createConversationHistoryStore } from '../../storage/conversationHistoryRepository'
import { createConversationRepository } from '../../storage/conversationRepository'
import { openBuddyDatabase } from '../../storage/database'
import { createExtensionReferenceRepository } from '../../storage/extensionReferenceRepository'
import { createExtensionTaskContextRepository } from '../../storage/extensionTaskContextRepository'
import { createRunInputRepository } from '../../storage/runInputRepository'
import { createRunRepository } from '../../storage/runRepository'
import { createExtensionReferenceCapabilities } from '../extensionReferenceCapabilities'
import { ExtensionTaskContext } from '../ExtensionTaskContext'
import { ReferenceSnapshotAccess } from '../ReferenceSnapshotAccess'

const databases: DatabaseSync[] = []
afterEach(() => databases.splice(0).forEach(database => database.close()))
function fixture() {
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  databases.push(database)
  const tasks = createConversationRepository(database)
  const createdAt = '2026-10-24T00:00:00.000Z'
  tasks.create({ id: 'task', branchId: 'branch', title: 'Office', spaceId: null, approvalPolicy: 'policy', executionProfile: 'workspace_write', createdAt })
  const lineage = createConversationHistoryStore(database).lineage
  const history = createExtensionTaskContextRepository(database, lineage)
  const references = createExtensionReferenceRepository(database, lineage)
  const domain = new ExtensionTaskContext(tasks, history, createRunRepository(database), createRunInputRepository(database))
  const controller = new AbortController()
  let sequence = 0
  function quote(extensionId = 'tests.office', targetExtension = extensionId) {
    return { id: randomUUID(), text: 'Frozen selected text', locator: { version: 1, data: { documentId: 'private-document', revision: 7 } }, source: { kind: 'view', title: 'Budget.xlsx', provider: `extension:${extensionId}`, target: { extensionId: targetExtension, viewId: randomUUID(), viewType: 'tests.office.editor', source: null } } }
  }
  function message(quotes: ReturnType<typeof quote>[], options: { branch?: string, role?: 'user' | 'assistant' | 'tool', committed?: boolean, runId?: string } = {}) {
    const id = `message-${++sequence}`
    const createdAt = new Date(Date.UTC(2026, 9, 24, 0, 0, sequence)).toISOString()
    const branchId = options.branch ?? 'branch'
    const runId = options.runId ?? `run-${sequence}`
    tasks.createMessage({ id, conversationId: 'task', branchId, runId: null, role: options.role ?? 'user', createdAt, content: { resourceSnapshots: [], userContent: { version: 1, body: [{ type: 'paragraph', content: [{ type: 'text', text: 'Use these references' }] }], panelResourceIds: [], resourceQuotes: quotes } } })
    if (options.committed !== false) {
      database.prepare(`INSERT INTO runs (id, conversation_id, branch_id, triggering_message_id, provider, model, purpose, status, started_at)
        VALUES (?, 'task', ?, ?, 'fixture', 'fixture', 'chat', 'running', ?)`).run(runId, branchId, id, createdAt)
    }
    return { id, runId, createdAt }
  }
  function invocation(runId: string, action = false) {
    const scope: ExtensionInvocationScope = { conversationId: 'task', runId, extensionId: 'tests.office', invocationId: randomUUID(), signal: controller.signal, ...action ? { action: { id: 'tests.office.action', cause: { type: 'user' as const } } } : {} }
    return { handlers: createExtensionReferenceCapabilities(references, domain.open(scope), scope), context: { ...scope, callNumber: 1 } }
  }
  function acceptFollowup(runId: string, reference: ReturnType<typeof quote>) {
    const input = message([reference], { committed: false })
    database.prepare(`INSERT INTO chat_queue (id, conversation_id, branch_id, request_id, request_fingerprint, prepared_json, state, run_id, created_at)
      VALUES (?, 'task', 'branch', ?, 'fingerprint', ?, 'waiting', ?, ?)`).run(input.id, randomUUID(), JSON.stringify({ userMessageId: input.id }), runId, input.createdAt)
    database.prepare('UPDATE chat_queue SET state = \'sent\' WHERE id = ?').run(input.id)
    return input
  }
  function child(rootRunId: string, kind: 'actor_child' | 'npc_child', privateQuote: ReturnType<typeof quote>) {
    const input = message([privateQuote], { committed: false })
    createRunRepository(database).create({ id: input.runId, conversationId: 'task', branchId: 'branch', triggeringMessageId: input.id, provider: 'fixture', model: 'fixture', purpose: 'chat', status: 'running', piSessionFile: null, approvalPolicy: 'policy', executionProfile: 'read_only', startedAt: input.createdAt, rootRunId, parentRunId: rootRunId, executionKind: kind })
    return input
  }
  return { database, tasks, quote, message, invocation, controller, acceptFollowup, child, references }
}

describe('run-owned extension references', () => {
  it.each(['text', 'locator', 'target'])('binds repeated reference ids to a message and rejects ambiguous %s lookups', async (change) => {
    const f = fixture()
    const quote = f.quote()
    const first = f.message([quote])
    const changed = structuredClone(quote)
    if (change === 'text')
      changed.text = 'A different selected region'
    if (change === 'locator')
      changed.locator.data.revision = 8
    if (change === 'target')
      changed.source.target.viewId = randomUUID()
    const second = f.message([changed])
    const call = f.invocation(second.runId)
    await expect(call.handlers['references.resolve']({ referenceId: quote.id }, call.context)).rejects.toThrow('EXTENSION_REFERENCE_AMBIGUOUS')
    expect(await call.handlers['references.resolve']({ referenceId: quote.id, sourceMessageId: first.id }, call.context)).toMatchObject({ sourceMessageId: first.id, text: quote.text, locator: quote.locator })
    expect(await call.handlers['references.resolve']({ referenceId: quote.id, sourceMessageId: second.id }, call.context)).toMatchObject({ sourceMessageId: second.id, text: changed.text, locator: changed.locator })
    await expect(call.handlers['references.resolve']({ referenceId: quote.id, sourceMessageId: 'unrelated-message' }, call.context)).rejects.toThrow('EXTENSION_REFERENCE_UNAVAILABLE')
  })
  it('resolves historical user snapshots after continuation without exposing opaque metadata in listing', async () => {
    const f = fixture()
    const historical = f.quote()
    const first = f.message([historical])
    const current = f.message([historical])
    const call = f.invocation(current.runId)
    const list = await call.handlers['references.list'](null, call.context)
    expect(list).toEqual({ items: [current, first].map(message => ({ referenceId: historical.id, sourceMessageId: message.id, title: 'Budget.xlsx', excerpt: 'Frozen selected text' })), truncated: false })
    expect(JSON.stringify(list)).not.toContain('private-document')
    expect(await call.handlers['references.resolve']({ referenceId: historical.id }, call.context)).toEqual({ referenceId: historical.id, sourceMessageId: current.id, title: 'Budget.xlsx', text: historical.text, textLength: historical.text.length, textDigest: createHash('sha256').update(historical.text).digest('hex'), offset: 0, nextOffset: null, locator: historical.locator, scope: { taskId: 'task', branchId: 'branch' } })
  })

  it('includes committed same-run follow-ups but not later uncommitted or other-run inputs', async () => {
    const f = fixture()
    const first = f.message([])
    const accepted = f.quote()
    f.acceptFollowup(first.runId, accepted)
    const uncommitted = f.quote()
    f.message([uncommitted], { committed: false })
    const later = f.quote()
    f.message([later])
    const call = f.invocation(first.runId)
    expect(await call.handlers['references.list'](null, call.context)).toMatchObject({ items: [{ referenceId: accepted.id }] })
    await expect(call.handlers['references.resolve']({ referenceId: uncommitted.id }, call.context)).rejects.toThrow('EXTENSION_REFERENCE_UNAVAILABLE')
    await expect(call.handlers['references.resolve']({ referenceId: later.id }, call.context)).rejects.toThrow('EXTENSION_REFERENCE_UNAVAILABLE')
  })

  it('excludes other plugins, forged providers, assistant/tool messages and invisible branch history', async () => {
    const f = fixture()
    const ancestor = f.quote()
    const fork = f.message([ancestor])
    const hidden = f.quote()
    f.message([hidden])
    f.tasks.createBranch({ id: 'active', conversationId: 'task', parentBranchId: 'branch', forkedFromMessageId: fork.id, createdAt: '2026-10-24T00:01:00.000Z', activate: true })
    const other = f.quote('tests.other')
    const forged = f.quote('tests.office', 'tests.other')
    f.message([other, forged], { branch: 'active' })
    const assistant = f.quote()
    const tool = f.quote()
    f.message([assistant], { branch: 'active', role: 'assistant' })
    f.message([tool], { branch: 'active', role: 'tool' })
    const current = f.message([], { branch: 'active' })
    const call = f.invocation(current.runId)
    expect(await call.handlers['references.list'](null, call.context)).toMatchObject({ items: [{ referenceId: ancestor.id }] })
    for (const quote of [hidden, other, forged, assistant, tool])
      await expect(call.handlers['references.resolve']({ referenceId: quote.id }, call.context)).rejects.toThrow('EXTENSION_REFERENCE_UNAVAILABLE')
  })

  it.each(['actor_child', 'npc_child'] as const)('keeps %s plugin and generic reference scope frozen when its parent accepts later input', async (kind) => {
    const f = fixture()
    const original = f.quote()
    const root = f.message([original])
    const privateQuote = f.quote()
    const child = f.child(root.runId, kind, privateQuote)
    const future = f.quote()
    const accepted = f.acceptFollowup(root.runId, future)
    const call = f.invocation(child.runId)
    expect(await call.handlers['references.list'](null, call.context)).toMatchObject({ items: [{ referenceId: original.id }] })
    for (const quote of [privateQuote, future])
      await expect(call.handlers['references.resolve']({ referenceId: quote.id }, call.context)).rejects.toThrow('EXTENSION_REFERENCE_UNAVAILABLE')
    const generic = new ReferenceSnapshotAccess({ conversationId: 'task', getRunId: () => child.runId, references: f.references, signal: f.controller.signal })
    expect(() => generic.read({ referenceId: future.id, sourceMessageId: accepted.id, kind: 'resource' })).toThrow('REFERENCE_NOT_AUTHORIZED')
    const parent = f.invocation(root.runId)
    expect(await parent.handlers['references.resolve']({ referenceId: future.id }, parent.context)).toMatchObject({ referenceId: future.id })
  })

  it.each(['new input', 'branch', 'delete', 'abort', 'run complete'])('revokes list and resolve after %s', async (change) => {
    const f = fixture()
    const quote = f.quote()
    const input = f.message([quote])
    const call = f.invocation(input.runId)
    if (change === 'new input')
      f.message([])
    if (change === 'branch')
      f.tasks.createBranch({ id: 'other', conversationId: 'task', parentBranchId: 'branch', forkedFromMessageId: input.id, createdAt: '2026-10-24T00:01:00.000Z', activate: true })
    if (change === 'delete')
      f.tasks.markDeleted('task', '2026-10-24T00:01:00.000Z')
    if (change === 'abort')
      f.controller.abort()
    if (change === 'run complete')
      f.database.prepare('UPDATE runs SET status = \'completed\' WHERE id = ?').run(input.runId)
    await expect(call.handlers['references.list'](null, call.context)).rejects.toThrow()
    await expect(call.handlers['references.resolve']({ referenceId: quote.id }, call.context)).rejects.toThrow()
  })

  it('rejects actions and guessed message-local quote numbers', async () => {
    const f = fixture()
    const quote = f.quote()
    const input = f.message([quote])
    const action = f.invocation(input.runId, true)
    await expect(action.handlers['references.list'](null, action.context)).rejects.toThrow('EXTENSION_REFERENCE_UNAVAILABLE')
    const call = f.invocation(input.runId)
    await expect(call.handlers['references.resolve']({ referenceId: '1' }, call.context)).rejects.toThrow()
  })

  it('keeps worst-case Unicode and escaped text listings inside the normal RPC budget', async () => {
    const f = fixture()
    let input
    for (let index = 0; index < 100; index++) {
      const quote = f.quote()
      input = f.message([{ ...quote, text: `a${'\u0001'.repeat(511)}`, source: { ...quote.source, title: '字'.repeat(512) } }])
    }
    const call = f.invocation(input!.runId)
    const result = await call.handlers['references.list'](null, call.context)
    expect(extensionJsonSchema.safeParse(result).success).toBe(true)
    expect(result).toMatchObject({ truncated: true })
  })

  it('bounds listings and resolves older references beyond the list', async () => {
    const f = fixture()
    const oldest = f.quote()
    f.message([oldest])
    let input
    for (let index = 0; index < 105; index++)
      input = f.message([{ ...f.quote(), text: 'x'.repeat(1000) }])
    const call = f.invocation(input!.runId)
    const result = await call.handlers['references.list'](null, call.context) as { items: { excerpt: string }[], truncated: boolean }
    expect(result.items).toHaveLength(100)
    expect(result.items.every(item => item.excerpt.length === 512)).toBe(true)
    expect(result.truncated).toBe(true)
    expect(await call.handlers['references.resolve']({ referenceId: oldest.id }, call.context)).toMatchObject({ referenceId: oldest.id })
  })

  it('pages long snapshots inside the IPC budget with a digest of the full UTF-8 text', async () => {
    const f = fixture()
    const quote = { ...f.quote(), text: `字😀${'\u0001'.repeat(210000)}` }
    const input = f.message([quote])
    const call = f.invocation(input.runId)
    const digest = createHash('sha256').update(quote.text, 'utf8').digest('hex')
    let offset: number | null = 0
    let text = ''
    while (offset !== null) {
      const result = await call.handlers['references.resolve']({ referenceId: quote.id, offset }, call.context) as { text: string, offset: number, nextOffset: number | null, textLength: number, textDigest: string }
      expect(extensionJsonSchema.safeParse(result).success).toBe(true)
      expect(result).toMatchObject({ textLength: quote.text.length, textDigest: digest, offset })
      expect(result.text.length).toBeLessThanOrEqual(32768)
      text += result.text
      offset = result.nextOffset
    }
    expect(text).toBe(quote.text)
    await expect(call.handlers['references.resolve']({ referenceId: quote.id, offset: quote.text.length + 1 }, call.context)).rejects.toThrow('EXTENSION_REFERENCE_OFFSET_OUT_OF_RANGE')
    await expect(call.handlers['references.resolve']({ referenceId: quote.id, limit: 32769 }, call.context)).rejects.toThrow()
    f.controller.abort()
    await expect(call.handlers['references.resolve']({ referenceId: quote.id, offset: 32768 }, call.context)).rejects.toThrow()
  })
})
