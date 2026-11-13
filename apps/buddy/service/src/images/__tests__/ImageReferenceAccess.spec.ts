import type { ExtensionAPI, ExtensionToolContext, ToolCallEvent, ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { BuddyRunEvent } from '../../events/BuddyRunEvent'
import type { ImageReferencePage } from '../ImageReferenceAccess'
import { afterEach, describe, expect, it } from 'vitest'
import { createBuddyUserContent } from '../../../../shared/conversation/buddyUserContent'
import { ArtifactService } from '../../artifacts/ArtifactService'
import { AttachmentService } from '../../attachments/AttachmentService'
import { RunEventQueries } from '../../events/RunEventQueries'
import { createExecutionStorageFixture } from '../../storage/__tests__/executionFixture'
import { createArtifactRepository } from '../../storage/artifactRepository'
import { createAttachmentRepository } from '../../storage/attachmentRepository'
import { BuddyDataPaths } from '../../storage/BuddyDataPaths'
import { createChatQueueRepository } from '../../storage/chatQueueRepository'
import { createComposerDraftRepository } from '../../storage/composerDraftRepository'
import { projectConversationPublication } from '../../storage/conversationPublicationRepository'
import { createConversationTreeRepository } from '../../storage/conversationTreeRepository'
import { hashChildAdmissionRequest } from '../../storage/executionRepository'
import { createRunInputRepository } from '../../storage/runInputRepository'
import { ImageReferenceAccess } from '../ImageReferenceAccess'
import { createImageReferenceCapability } from '../imageReferenceExtension'

const fixtures: ReturnType<typeof createExecutionStorageFixture>[] = []
afterEach(() => fixtures.splice(0).forEach(f => f.database.close()))

function fixture() {
  const f = createExecutionStorageFixture()
  fixtures.push(f)
  const records = createAttachmentRepository(f.database)
  const artifactRecords = createArtifactRepository(f.database)
  const publications = createConversationTreeRepository(f.database)
  const controller = new AbortController()
  let currentRunId = 'root'
  let counter = 0
  const now = () => new Date(Date.UTC(2026, 9, 24, 0, 0, counter++)).toISOString()
  const access = new ImageReferenceAccess({
    conversationId: 'conversation',
    getRunId: () => currentRunId,
    signal: controller.signal,
    conversations: f.conversations,
    publications,
    executions: f.executions,
    inputs: createRunInputRepository(f.database),
    events: new RunEventQueries(f.database),
    attachments: new AttachmentService({ paths: new BuddyDataPaths('/fixture'), repository: records }),
    artifacts: new ArtifactService({ repository: artifactRecords }),
  })
  function message(id: string, branchId = 'branch', conversationId = 'conversation') {
    return f.conversations.createMessage({ id, conversationId, branchId, role: 'user', runId: null, createdAt: now(), content: { resourceSnapshots: [], userContent: createBuddyUserContent('Reference fixture') } })
  }
  function attachment(id: string, messageId = 'goal', mimeType = 'image/png', createdAt = now()) {
    const path = `/fixture/${id}.png`
    return records.create({ id, conversationId: 'conversation', messageId, draftId: null, storedPath: path, name: `${id}.png`, mimeType, sizeBytes: 1, createdAt })
  }
  function inputs(runId: string, ids: string[]) {
    f.database.prepare('INSERT INTO run_inputs (run_id, prompt, attachment_ids_json, context_items_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(runId, 'Reference fixture', JSON.stringify(ids), '[]', now())
  }
  function root(id: string, messageId: string, ids: string[] = [], branchId = 'branch', conversationId = 'conversation') {
    const run = f.runs.create({ id, conversationId, branchId, triggeringMessageId: messageId, buddyId: 'default', actorSnapshot: f.snapshot('default'), provider: 'fixture', model: 'fixture', purpose: 'chat', status: 'running', piSessionFile: null, startedAt: now(), approvalPolicy: 'policy', executionProfile: 'workspace_write' })
    inputs(id, ids)
    currentRunId = id
    return run
  }
  function output(id: string, runId: string, sequence = 1) {
    const run = f.runs.findById(runId)!
    const createdAt = now()
    artifactRecords.save({ id, conversationId: run.conversationId, createdAt, updatedAt: createdAt, currentPath: `/fixture/${id}.png`, directoryGrantId: 'grant', directoryRoot: '/fixture', relativePath: `${id}.png`, name: `${id}.png`, mimeType: 'image/png', sizeBytes: 1, kind: 'file', sourceArtifactId: null })
    const event: BuddyRunEvent = { runId, sequence, type: 'output.produced', payload: { artifactIds: [id], sourceToolCallId: `tool-${id}`, sourceToolName: 'lexora_image_generate' }, createdAt }
    f.database.prepare('INSERT INTO run_events (run_id, sequence, event_type, payload_json, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(runId, sequence, event.type, JSON.stringify(event.payload), createdAt)
    projectConversationPublication(f.database, event)
    return `output:${runId}:${sequence}`
  }
  function child(id: string, options: { callerId?: string, sources?: string[], attachments?: string[], previousRunId?: string, conversation?: boolean, actor?: boolean } = {}) {
    const input = f.child(id, options.actor ? f.actor.id : f.npc.id, options.callerId ?? 'root')
    input.work = { contextMode: options.conversation ? 'conversation' : 'isolated', contextSourceIds: options.sources ?? [], previousRunId: options.previousRunId }
    input.initialInput.attachmentIds = options.attachments ?? []
    input.requestHash = hashChildAdmissionRequest(input)
    const record = f.executions.admitChild(input).execution
    f.executions.claimWorking(f.fence(id))
    f.runs.markRunning(id, now())
    currentRunId = id
    return record
  }
  message('goal')
  return { ...f, access, controller, now, message, attachment, inputs, root, output, child, publications, setRun: (id: string) => {
    currentRunId = id
  }, ids: () => access.list({}, controller.signal).items.map(item => item.referenceId) }
}

describe('visible image references', () => {
  it('uses frozen branch publications, not the default branch or newer conversation images', () => {
    const f = fixture()
    f.attachment('old', 'goal')
    f.inputs('root', ['old'])
    f.output('old-output', 'root')
    f.message('accepted')
    f.root('accepted-run', 'accepted')
    f.message('late')
    f.attachment('late', 'late')
    f.root('late-run', 'late', ['late'])
    f.output('late-output', 'late-run')
    f.setRun('accepted-run')
    expect(new Set(f.ids())).toEqual(new Set(['old', 'old-output']))
    expect(() => f.access.authorize(['late'], f.controller.signal)).toThrow('IMAGE_REFERENCE_NOT_VISIBLE')
    f.conversations.createBranch({ id: 'fork', conversationId: 'conversation', parentBranchId: 'branch', forkedFromMessageId: 'goal', createdAt: f.now(), activate: true })
    expect(new Set(f.ids())).toEqual(new Set(['old', 'old-output']))
    f.message('fork-input', 'fork')
    f.root('fork-run', 'fork-input', [], 'fork')
    expect(f.ids()).toEqual(['old'])
    expect(() => f.access.authorize(['old-output'], f.controller.signal)).toThrow('IMAGE_REFERENCE_NOT_VISIBLE')
  })

  it('does not grant isolated children caller images or peer private outputs', () => {
    const f = fixture()
    f.attachment('accepted')
    f.inputs('root', ['accepted'])
    f.output('public-output', 'root')
    f.child('private')
    f.output('private-output', 'private')
    expect(f.ids()).toEqual(['private-output'])
    expect(() => f.access.authorize(['accepted', 'public-output'], f.controller.signal)).toThrow('IMAGE_REFERENCE_NOT_VISIBLE')
    f.child('peer')
    expect(f.ids()).toEqual([])
    expect(() => f.access.authorize(['private-output'], f.controller.signal)).toThrow('IMAGE_REFERENCE_NOT_VISIBLE')
    f.setRun('root')
    expect(new Set(f.ids())).toEqual(new Set(['accepted', 'public-output']))
    expect(() => f.access.authorize(['private-output'], f.controller.signal)).toThrow('IMAGE_REFERENCE_NOT_VISIBLE')
  })

  it('admits only explicit public selections and handed-off attachments, retaining them on same-work continuation', () => {
    const f = fixture()
    f.attachment('accepted')
    f.inputs('root', ['accepted'])
    const selected = f.output('selected-output', 'root')
    f.message('new-goal')
    f.root('new-root', 'new-goal')
    const first = f.child('selected', { callerId: 'new-root', sources: [selected] })
    expect(f.ids()).toEqual(['selected-output'])
    f.output('own-output', 'selected')
    f.runs.reconcileTerminal('selected', 'completed', f.now(), null)
    f.executions.recordCleanup('selected', 'clean', null)
    const next = f.child('continued', { callerId: 'new-root', previousRunId: 'selected' })
    expect(next.run.threadId).toBe(first.run.threadId)
    expect(new Set(f.ids())).toEqual(new Set(['selected-output', 'own-output']))
    f.child('handed', { attachments: ['accepted'] })
    expect(f.ids()).toEqual(['accepted'])
    expect(() => f.access.authorize(['selected-output'], f.controller.signal)).toThrow('IMAGE_REFERENCE_NOT_VISIBLE')
  })

  it('gives conversation-mode actors the accepted public snapshot without private NPC artifacts', () => {
    const f = fixture()
    f.attachment('accepted')
    f.inputs('root', ['accepted'])
    f.output('public-output', 'root')
    f.child('npc')
    f.output('private-output', 'npc')
    f.message('new-goal')
    f.root('new-root', 'new-goal')
    f.child('actor', { callerId: 'new-root', conversation: true, actor: true })
    expect(new Set(f.ids())).toEqual(new Set(['accepted', 'public-output']))
  })

  it('accepts queued materials only after commit and does not retroactively pass them to children', () => {
    const f = fixture()
    f.inputs('root', [])
    f.child('before-queue')
    const queue = createChatQueueRepository(f.database)
    const source = f.attachment('queued-source')
    const draft = createComposerDraftRepository(f.database).open({
      draftId: 'queued-draft',
      scope: { kind: 'global' },
      initialContent: createBuddyUserContent('Queued image'),
      initialModelSelection: null,
      initialExecutionConfig: { approvalPolicy: 'policy', executionProfile: 'workspace_write' },
      now: f.now(),
    })
    queue.enqueue({
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
      branchId: 'branch',
      conversationId: 'conversation',
      createdAt: f.now(),
      draft: { draftId: draft.draftId, expectedRevision: draft.revision },
      model: 'fixture',
      provider: 'fixture',
      requestId: 'queued-request',
      requestFingerprint: 'fingerprint',
      runId: 'queued-run',
      spaceId: null,
      title: 'Fixture',
      userMessageId: 'queued',
      attachmentBindings: [{ id: 'queued-image', messageId: 'queued', sourceAttachmentId: source.id, sourceDraftId: null, storedPath: '/fixture/queued-image.png', createdAt: source.createdAt, mimeType: source.mimeType }],
      userMessageContent: { resourceSnapshots: [], userContent: createBuddyUserContent('Queued image') },
      runInput: { prompt: 'Queued image', attachmentIds: ['queued-image'], contextItems: [], reasoning: null, serviceTier: null },
    })
    f.setRun('root')
    expect(f.ids()).toEqual([])
    queue.commitInRun({ ...queue.pending({ conversationId: 'conversation', branchId: 'branch', id: 'queued' })!, actorSnapshot: f.snapshot('default') }, 'root', undefined)
    expect(f.ids()).toEqual(['queued-image'])
    f.setRun('before-queue')
    expect(f.ids()).toEqual([])
  })

  it('rejects other tasks, unaccepted files, non-images and composer resource identities', () => {
    const f = fixture()
    f.attachment('accepted')
    f.attachment('text', 'goal', 'text/plain')
    f.inputs('root', ['accepted', 'text'])
    f.message('unaccepted')
    f.attachment('unaccepted', 'unaccepted')
    f.conversations.create({ id: 'other', branchId: 'other-branch', title: 'Other', spaceId: null, createdAt: f.now(), approvalPolicy: 'policy', executionProfile: 'workspace_write' })
    f.message('other-input', 'other-branch', 'other')
    f.attachment('foreign', 'other-input')
    f.root('foreign-run', 'other-input', ['foreign'], 'other-branch', 'other')
    f.output('foreign-output', 'foreign-run')
    f.message('current')
    f.root('current-run', 'current')
    expect(f.ids()).toEqual(['accepted'])
    for (const id of ['foreign', 'foreign-output', 'unaccepted', 'text', 'composer-resource', 'missing', '/fixture/accepted.png'])
      expect(() => f.access.authorize([id], f.controller.signal)).toThrow('IMAGE_REFERENCE_NOT_VISIBLE')
    expect(() => f.access.authorize([''], f.controller.signal)).toThrow('IMAGE_REFERENCE_INVALID')
    const ids = Object.freeze(['accepted', 'accepted'])
    f.access.authorize(ids, f.controller.signal)
    expect(ids).toEqual(['accepted', 'accepted'])
    f.setRun('foreign-run')
    expect(() => f.ids()).toThrow('IMAGE_REFERENCE_SCOPE_UNAVAILABLE')
  })

  it('pages deterministically, filters metadata, bounds requests and preserves authorization order', () => {
    const f = fixture()
    const ids = Array.from({ length: 55 }, (_, index) => `image-${String(index).padStart(2, '0')}`)
    const time = f.now()
    for (const id of ids.toReversed())
      f.attachment(id, 'goal', 'image/png', time)
    f.inputs('root', ids)
    const first = f.access.list({ limit: 50 }, f.controller.signal)
    const second = f.access.list({ offset: first.nextOffset! }, f.controller.signal)
    expect(first).toMatchObject({ total: 55, nextOffset: 50 })
    expect(second.nextOffset).toBeNull()
    expect([...first.items, ...second.items].map(item => item.referenceId)).toEqual(ids)
    expect(f.access.list({ query: 'IMAGE-03' }, f.controller.signal).items).toEqual([first.items[3]])
    expect(f.access.list({ offset: 55 }, f.controller.signal).items).toEqual([])
    expect(() => f.access.list({ offset: 56 }, f.controller.signal)).toThrow('IMAGE_REFERENCE_OFFSET_OUT_OF_RANGE')
    for (const query of [{ limit: 51 }, { limit: 0 }, { offset: -1 }, { offset: 1.5 }, { query: 'x'.repeat(257) }])
      expect(() => f.access.list(query, f.controller.signal)).toThrow('IMAGE_REFERENCE_QUERY_INVALID')
    const ordered = Object.freeze(['image-54', 'image-01', 'image-25'])
    f.access.authorize(ordered, f.controller.signal)
    expect(ordered).toEqual(['image-54', 'image-01', 'image-25'])
  })

  it.each(['abort', 'deleted', 'terminal', 'cancelled'] as const)('revalidates %s scope at execution, with read-only on-demand disclosure', async (change) => {
    const f = fixture()
    f.attachment('accepted')
    f.inputs('root', ['accepted'])
    const capability = createImageReferenceCapability(f.access)
    const tools: ToolDefinition[] = []
    await capability.extension.factory({ registerTool: (tool: ToolDefinition) => tools.push(tool) } as unknown as ExtensionAPI)
    expect(capability.disclosure).toMatchObject([{ exposure: 'on_demand', tools: [{ name: 'lexora_image_list', namespace: { name: 'lexora_image' } }] }])
    const event: ToolCallEvent = { type: 'tool_call', toolName: 'lexora_image_list', toolCallId: 'call', input: {} }
    expect(await capability.classify(event, f.controller.signal)).toEqual({ access: 'read', paths: [] })
    const result = await tools[0]!.execute('call', {}, f.controller.signal, undefined, {} as ExtensionToolContext)
    const text = result.content.find(content => content.type === 'text')!
    const page: ImageReferencePage = JSON.parse(text.text)
    expect(page.items[0]).toMatchObject({ referenceId: 'accepted', sourceKind: 'attachment', sourceMessageId: 'goal', mimeType: 'image/png' })
    await expect(tools[0]!.execute('call', { limit: 1000 }, f.controller.signal, undefined, {} as ExtensionToolContext)).rejects.toThrow('VALIDATION_FAILED')
    if (change === 'abort')
      f.controller.abort()
    if (change === 'deleted')
      f.conversations.markDeleted('conversation', f.now())
    if (change === 'terminal')
      f.runs.reconcileTerminal('root', 'completed', f.now(), null)
    if (change === 'cancelled')
      f.database.prepare('UPDATE execution_state SET cancel_requested_at = ? WHERE run_id = ?').run(f.now(), 'root')
    await expect(tools[0]!.execute('call', {}, f.controller.signal, undefined, {} as ExtensionToolContext)).rejects.toThrow()
    expect(() => f.access.authorize(['accepted'], f.controller.signal)).toThrow()
  })
})
