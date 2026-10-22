import type { Api, AssistantMessage, Context, Model } from '@earendil-works/pi-ai'
import type { BuddyExtensionRunContextStore } from '../../extensions/BuddyExtensionRunContext'
import type { BuddyInProcessExtension } from '../../extensions/BuddyInProcessExtension'
import type { BuddySessionBlueprint } from '../../sessions/BuddySessionBlueprint'
import type { ActiveRunSession } from '../ActiveRunRegistry'
import type { ExecutionContinuationPort, ExecutionInputState, ExecutionMailboxMessage, ExecutionMailboxReceipt } from '../ExecutionContinuationPort'
import { mkdirSync, renameSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime, SessionManager } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EXECUTION_MAILBOX_ENTRY_TYPE } from '../../../../../shared/executions/executionApi'
import { createRunEventLog } from '../../../events/createRunEventLog'
import { RunContinuityService } from '../../../runs/RunContinuityService'
import { createConversationRepository } from '../../../storage/conversationRepository'
import { createConversationTreeRepository } from '../../../storage/conversationTreeRepository'
import { openBuddyDatabase } from '../../../storage/database'
import { hashExecutionMailboxMessage } from '../../../storage/mailboxRepository'
import { createRunRepository } from '../../../storage/runRepository'
import { createThreadBindingRepository } from '../../../storage/threadBindingRepository'
import { createUsageRepository } from '../../../storage/usageRepository'
import { UsageService } from '../../../usage/UsageService'
import { createBuddyInputReference } from '../../context/BuddyInputReference'
import { PiEventBridge } from '../../events/PiEventBridge'
import { createCompactionTimingExtension } from '../../extensions/compactionTimingExtension'
import { createInputReferenceExtension } from '../../extensions/inputReferenceExtension'
import { toBuddySessionIdentity } from '../../sessions/BuddySessionBlueprint'
import { BuddySessionRegistry } from '../../sessions/BuddySessionRegistry'
import { createBuddySession } from '../../sessions/createBuddySession'
import { createReusableBuddySession } from '../../sessions/createReusableBuddySession'
import { BuddyConversationTree } from '../../sessions/tree/BuddyConversationTree'
import { readCheckpoint } from '../../sessions/tree/BuddyTreeStore'
import { readExecutionMailboxEntries } from '../executionMailboxEntries'
import { PiTurnExecutor } from '../PiTurnExecutor'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

describe('execution continuation through real Pi sessions', () => {
  it('accepts idle input, drains FIFO and checkpoints the same run only after consuming the child result', async () => {
    const f = await fixture()
    const mailbox = createMailbox(f)
    const completion = f.execute(mailbox.port)
    await mailbox.waiting.promise
    expect(f.session.isStreaming).toBe(false)
    const input = (id: string) => createBuddyInputReference({ messageId: id, prompt: `USER_${id}`, images: [], attachmentIds: ['attachment'], resourceLabels: { attachment: '[FILE#1]' } })
    expect(f.active()!.steer!(() => input('B'))).toBe(true)
    const queued = ['A', 'C']
    mailbox.port.followUp = async () => {
      const id = queued.shift()
      return id ? f.active()!.followUp!(() => input(id)) : false
    }
    await vi.waitFor(() => expect(f.requests).toHaveLength(4))
    expect(f.requests.slice(1).map(request => request.messages.filter(message => message.role === 'user').at(-1)?.content)).toEqual([
      [{ type: 'text', text: 'USER_B' }],
      [{ type: 'text', text: 'USER_A' }],
      [{ type: 'text', text: 'USER_C' }],
    ])
    expect(f.checkpoints()).toEqual(['before'])
    expect(f.runContext.current?.runId).toBe(f.run.id)
    mailbox.send(f.message('later-child-result', 'CHILD_STILL_COMPLETED'))
    mailbox.finishChildren()
    expect(await completion).toMatchObject({ status: 'completed' })
    expect(f.requests).toHaveLength(5)
    expect(JSON.stringify(f.requests[4])).toContain('CHILD_STILL_COMPLETED')
    expect(mailbox.consumed.map(receipt => receipt.messageId)).toEqual(['later-child-result'])
    expect(mailbox.consumed).toEqual(mailbox.accepted)
    expect(f.checkpoints()).toEqual(['before', 'after'])
    expect(f.runContext.current).toBeNull()
    const messages = (await f.eventLog.read(f.run.id)).filter(event => event.type === 'message.completed')
    expect(messages).toHaveLength(f.requests.length)
    expect(new Set(messages.map(event => (event.payload as { messageId: string }).messageId)).size).toBe(messages.length)
    expect(f.database.prepare('SELECT count(*) AS count FROM usage_records WHERE run_id = ?').get(f.run.id)?.count).toBe(f.requests.length)
    const journal = await readFile(f.file, 'utf8')
    for (const id of ['A', 'B', 'C']) {
      const references = journal.split('\n').filter(line => line.includes(`"messageId":"${id}"`))
      expect(references).toHaveLength(1)
      expect(references[0]).toContain('[FILE#1]')
      expect(references[0]).toContain('attachment')
    }
  })

  it.each(['agent_end', 'agent_settled'] as const)('delivers steering arriving at the native %s boundary exactly once', async (boundary) => {
    const f = await fixture()
    const mailbox = createMailbox(f)
    mailbox.finishChildren()
    let sent = false
    const unsubscribe = f.session.subscribe((event) => {
      if (event.type !== boundary || sent)
        return
      sent = true
      expect(f.active()!.steer!(() => createBuddyInputReference({ messageId: 'boundary', prompt: 'BOUNDARY_INPUT', images: [] }))).toBe(true)
    })
    try {
      expect(await f.execute(mailbox.port)).toMatchObject({ status: 'completed' })
      expect(f.requests).toHaveLength(2)
      expect(JSON.stringify(f.requests[1])).toContain('BOUNDARY_INPUT')
      const journal = (await readFile(f.file, 'utf8')).split('\n')
      expect(journal.filter(line => line.includes('"messageId":"boundary"'))).toHaveLength(1)
    }
    finally { unsubscribe() }
  })

  it('drains an ordinary queued input before closing even without children', async () => {
    const f = await fixture()
    const mailbox = createMailbox(f)
    mailbox.finishChildren()
    let delivered = false
    mailbox.port.followUp = async () => {
      if (delivered)
        return false
      delivered = true
      return f.active()!.followUp!(() => createBuddyInputReference({ messageId: 'queued', prompt: 'QUEUED_BEFORE_CLOSE', images: [] }))
    }
    expect(await f.execute(mailbox.port)).toMatchObject({ status: 'completed' })
    expect(f.requests).toHaveLength(2)
    expect(JSON.stringify(f.requests[1])).toContain('QUEUED_BEFORE_CLOSE')
    expect(f.checkpoints()).toEqual(['before', 'after'])
  })

  it('does not resume an accepted idle input after cancellation', async () => {
    const f = await fixture()
    const mailbox = createMailbox(f)
    const completion = f.execute(mailbox.port)
    await mailbox.waiting.promise
    expect(f.active()!.steer!(() => createBuddyInputReference({ messageId: 'late', prompt: 'CANCELLED_INPUT', images: [] }))).toBe(true)
    f.controller.abort()
    mailbox.finishChildren()
    expect(await completion).toMatchObject({ status: 'cancelled' })
    expect(f.requests).toHaveLength(1)
    expect(f.reusable.hasPendingInput()).toBe(false)
  })

  it('delivers a result committed during compaction before the first subsequent request', async () => {
    const pending: ExecutionMailboxMessage[] = []
    let compacted = 0
    const f: Awaited<ReturnType<typeof fixture>> = await fixture({
      delegationReply: () => ({ details: {}, content: [{ type: 'text', text: 'Independent tool finished' }] }),
      pending: () => pending,
      compact: () => {
        compacted++
        pending.push(f.message('during-compaction', 'CHILD_COMPLETED_DURING_COMPACTION'))
      },
    })
    const release = await f.reusable.activateTurn(f.turnContext)
    try {
      await f.reusable.prompt('Initial input')
      expect(compacted).toBe(1)
      expect(f.requests).toHaveLength(2)
      expect(JSON.stringify(f.requests[1])).toContain('CHILD_COMPLETED_DURING_COMPACTION')
      const entries = SessionManager.open(f.file).getBranch()
      expect(entries.filter(entry => entry.type === 'compaction')).toHaveLength(1)
      const deliveries = readExecutionMailboxEntries(entries, { runId: f.run.id, generation: f.run.generation })
      expect(deliveries).toHaveLength(1)
      expect(await f.reusable.readInternalMessageReceipts(pending)).toHaveLength(1)
    }
    finally {
      await f.reusable.finishTurn()
      release()
    }
  })

  it.each(['next-request', 'manual'] as const)('defers final-answer compaction until %s without losing the context', async (trigger) => {
    let compacted = 0
    const f = await fixture({ compact: () => {
      compacted++
    } })
    const release = await f.reusable.activateTurn(f.turnContext)
    try {
      await f.reusable.prompt('Initial input to retain')
      expect(compacted).toBe(0)
      expect(SessionManager.open(f.file).getBranch().filter(entry => entry.type === 'compaction')).toHaveLength(0)
      if (trigger === 'manual')
        await f.session.compact()
      await f.reusable.prompt('Continue with preserved context')
      expect(compacted).toBe(1)
      expect(f.requests).toHaveLength(2)
      expect(JSON.stringify(f.requests[1])).toContain('Preserved task context')
      expect(SessionManager.open(f.file).getBranch().filter(entry => entry.type === 'compaction')).toHaveLength(1)
    }
    finally {
      await f.reusable.finishTurn()
      release()
    }
  })

  it('consumes results delivered by repeated native waits once and resumes only for a later child', async () => {
    let delivered: ExecutionMailboxMessage
    const f = await fixture({ toolRounds: 2, delegationReply: () => {
      const details = { updates: [delivered] }
      return { details, content: [{ type: 'text', text: JSON.stringify(details) }] }
    } })
    delivered = f.message('native-result', 'RESULT_FROM_NATIVE_WAIT')
    const mailbox = createMailbox(f)
    mailbox.send(delivered)
    const completion = f.execute(mailbox.port)
    await mailbox.waiting.promise
    expect(f.requests).toHaveLength(3)
    expect(JSON.stringify(f.requests[1])).toContain('RESULT_FROM_NATIVE_WAIT')
    expect(mailbox.accepted).toHaveLength(1)
    expect(mailbox.consumed).toEqual(mailbox.accepted)
    const journal = SessionManager.open(f.file).getBranch()
    const deliveredEntries = journal.filter(entry => entry.type === 'message' && entry.message.role === 'toolResult' && entry.message.toolName === 'lexora_agents')
    expect(deliveredEntries).toHaveLength(2)
    expect(mailbox.accepted[0]!.contextEntryId).toBe(deliveredEntries[0]!.id)
    expect(journal.some(entry => entry.type === 'custom_message' && entry.customType === EXECUTION_MAILBOX_ENTRY_TYPE)).toBe(false)
    mailbox.send(f.message('later-result', 'RESULT_FROM_LATER_CHILD'))
    mailbox.finishChildren()
    await expect(completion).resolves.toMatchObject({ status: 'completed' })
    expect(f.requests).toHaveLength(4)
    const persisted = SessionManager.open(f.file).getBranch()
    const automatic = persisted.filter(entry => entry.type === 'custom_message' && entry.customType === EXECUTION_MAILBOX_ENTRY_TYPE)
    expect(automatic).toHaveLength(1)
    expect(JSON.stringify(automatic)).toContain('RESULT_FROM_LATER_CHILD')
    expect(JSON.stringify(automatic)).not.toContain('RESULT_FROM_NATIVE_WAIT')
    expect(mailbox.accepted).toHaveLength(2)
    expect(mailbox.consumed).toEqual(mailbox.accepted)
  })

  it('reuses the native journal marker before a receipt is committed and accepts it for an explicit continuation', async () => {
    let delivered: ExecutionMailboxMessage
    const f = await fixture({ delegationReply: () => {
      const details = { updates: [delivered] }
      return { details, content: [{ type: 'text', text: JSON.stringify(details) }] }
    } })
    delivered = f.message('journal-only-native', 'Native result survives the acceptance window')
    const release = await f.reusable.activateTurn(f.turnContext)
    try {
      await f.reusable.prompt('Initial input')
      const receipts = await f.reusable.readInternalMessageReceipts([delivered])
      expect(receipts).toHaveLength(1)
      expect(await f.reusable.appendInternalMessages([delivered])).toEqual(receipts)
      expect(await f.reusable.readInternalMessageReceipts([delivered])).toEqual(receipts)
      await f.reusable.resumeInternal(receipts)
      expect(f.requests).toHaveLength(3)
      const persisted = SessionManager.open(f.file).getBranch()
      expect(persisted.find(entry => entry.id === receipts[0]!.contextEntryId)).toMatchObject({ type: 'message', message: { role: 'toolResult', toolName: 'lexora_agents' } })
      expect(persisted.some(entry => entry.type === 'custom_message' && entry.customType === EXECUTION_MAILBOX_ENTRY_TYPE)).toBe(false)
    }
    finally {
      await f.reusable.finishTurn()
      release()
    }
  })

  it('accepts a durable tool result without consuming it when the following request fails', async () => {
    let delivered: ExecutionMailboxMessage
    const f = await fixture({ failRequest: 2, delegationReply: () => {
      const details = { updates: [delivered] }
      return { details, content: [{ type: 'text', text: JSON.stringify(details) }] }
    } })
    delivered = f.message('failed-summary-result', 'Child work completed')
    const mailbox = createMailbox(f)
    mailbox.send(delivered)
    mailbox.finishChildren()
    await expect(f.execute(mailbox.port)).resolves.toMatchObject({ status: 'failed' })
    expect(mailbox.accepted).toHaveLength(1)
    expect(mailbox.consumed).toEqual([])
    expect(f.requests).toHaveLength(2)
    const entries = SessionManager.open(f.file).getBranch()
    expect(entries.find(entry => entry.id === mailbox.accepted[0]!.contextEntryId)).toMatchObject({ type: 'message', message: { role: 'toolResult', toolName: 'lexora_agents' } })
    expect(entries.some(entry => entry.type === 'custom_message' && entry.customType === EXECUTION_MAILBOX_ENTRY_TYPE)).toBe(false)
  })

  it.each(['clipped-content', 'different-source'] as const)('rejects %s tool result evidence without accepting or consuming a mailbox source', async (mode) => {
    let delivered: ExecutionMailboxMessage
    const f = await fixture({ delegationReply: () => {
      const content = mode === 'different-source' ? { ...delivered, text: 'Self-consistent but not authoritative' } : delivered
      const details = { updates: [{ ...content, payloadHash: hashExecutionMailboxMessage(content) }] }
      return { details, content: [{ type: 'text', text: mode === 'clipped-content' ? 'Result was clipped' : JSON.stringify(details) }] }
    } })
    delivered = f.message('invalid-evidence', 'Authoritative child result')
    const mailbox = createMailbox(f)
    mailbox.send(delivered)
    mailbox.finishChildren()
    await expect(f.execute(mailbox.port)).resolves.toMatchObject({ status: 'failed', errorCode: 'SESSION_STORAGE_UNAVAILABLE' })
    expect(mailbox.accepted).toEqual([])
    expect(mailbox.consumed).toEqual([])
    expect(f.requests).toHaveLength(2)
  })

  it('does not lose a result arriving after the empty read and before waiting', async () => {
    const f = await fixture()
    const mailbox = createMailbox(f)
    let injected = false
    const port: ExecutionContinuationPort = {
      ...mailbox.port,
      readPending: async () => {
        const snapshot = await mailbox.port.readPending()
        if (!injected) {
          injected = true
          mailbox.send(f.message('racing-result', 'Arrived between read and wait'))
          mailbox.finishChildren()
        }
        return snapshot
      },
    }
    await expect(f.execute(port)).resolves.toMatchObject({ status: 'completed' })
    expect(f.requests).toHaveLength(2)
    expect(JSON.stringify(f.requests[1])).toContain('Arrived between read and wait')
    expect(mailbox.consumed).toHaveLength(1)
    expect(f.checkpoints()).toEqual(['before', 'after'])
  })

  it('finishes cancellation while waiting to regain a working permit', async () => {
    const f = await fixture()
    const mailbox = createMailbox(f)
    const port: ExecutionContinuationPort = {
      ...mailbox.port,
      readPending: async () => {
        f.controller.abort()
        mailbox.finishChildren()
        f.controller.signal.throwIfAborted()
        return { revision: 0, messages: [], shouldResume: false }
      },
    }
    await expect(f.execute(port)).resolves.toMatchObject({ status: 'cancelled' })
    expect(f.requests).toHaveLength(1)
    expect(mailbox.accepted).toEqual([])
    expect(f.checkpoints()).toEqual(['before', 'after'])
    expect(f.runContext.current).toBeNull()
  })

  it('makes mailbox delivery idempotent within the current branch and rejects conflicting or detached receipts', async () => {
    const f = await fixture()
    const release = await f.reusable.activateTurn(f.turnContext)
    try {
      await f.reusable.prompt('Initial input')
      const message = f.message('stable-result', 'Useful child result')
      const first = await f.reusable.appendInternalMessages([message])
      expect(await f.reusable.appendInternalMessages([message])).toEqual(first)
      expect(SessionManager.open(f.file).getBranch().filter(entry => entry.type === 'custom_message' && entry.customType === EXECUTION_MAILBOX_ENTRY_TYPE)).toHaveLength(1)
      const changed = { ...message, text: 'Different result', payloadHash: 'f'.repeat(64) }
      await expect(f.reusable.appendInternalMessages([changed])).rejects.toMatchObject({ code: 'SESSION_STORAGE_UNAVAILABLE' })
      await expect(f.reusable.appendInternalMessages([{ ...message, targetRunId: 'another-run' }])).rejects.toMatchObject({ code: 'CONVERSATION_BINDING_MISMATCH' })
      const entry = f.session.sessionManager.getBranch().find(entry => entry.id === first[0]!.contextEntryId)!
      f.session.sessionManager.branch(entry.parentId!)
      await expect(f.reusable.resumeInternal(first)).rejects.toMatchObject({ code: 'SESSION_STORAGE_UNAVAILABLE' })
      expect(f.requests).toHaveLength(1)
    }
    finally {
      await f.reusable.finishTurn()
      release()
    }
  })

  it('does not accept a native tool delivery when its journal cannot be synchronized', async () => {
    let delivered: ExecutionMailboxMessage
    const f = await fixture({ delegationReply: () => {
      const details = { updates: [delivered] }
      return { details, content: [{ type: 'text', text: JSON.stringify(details) }] }
    } })
    delivered = f.message('unflushed-native', 'Native result must remain unacknowledged')
    const mailbox = createMailbox(f)
    mailbox.send(delivered)
    mailbox.finishChildren()
    let interrupted = false
    f.session.subscribe((event) => {
      if (!interrupted && event.type === 'message_end' && event.message.role === 'toolResult' && event.message.toolName === 'lexora_agents') {
        interrupted = true
        renameSync(f.file, `${f.file}.saved`)
        mkdirSync(f.file)
      }
    })
    await expect(f.execute(mailbox.port)).resolves.toMatchObject({ status: 'failed', errorCode: 'SESSION_STORAGE_UNAVAILABLE' })
    expect(mailbox.accepted).toEqual([])
    expect(mailbox.consumed).toEqual([])
    expect(f.runs.findById(f.run.id)?.piSessionFile).toBeNull()
  })

  it('does not acknowledge a source marker when its journal cannot be synchronized', async () => {
    const f = await fixture()
    const mailbox = createMailbox(f)
    let interrupted = false
    f.session.subscribe((event) => {
      if (!interrupted && event.type === 'message_end' && event.message.role === 'custom' && event.message.customType === EXECUTION_MAILBOX_ENTRY_TYPE) {
        interrupted = true
        renameSync(f.file, `${f.file}.saved`)
        mkdirSync(f.file)
      }
    })
    const completion = f.execute(mailbox.port)
    await mailbox.waiting.promise
    mailbox.send(f.message('unflushed-result', 'Do not acknowledge this input'))
    mailbox.finishChildren()
    await expect(completion).resolves.toMatchObject({ status: 'failed', errorCode: 'SESSION_STORAGE_UNAVAILABLE' })
    expect(mailbox.accepted).toEqual([])
    expect(mailbox.consumed).toEqual([])
    expect(f.requests).toHaveLength(1)
    expect(f.runs.findById(f.run.id)?.piSessionFile).toBeNull()
  })

  it.each(['cancelled', 'failed'] as const)('waits for child cleanup after %s without using an aborted model signal or sending another request', async (status) => {
    const f = await fixture({ failRequest: status === 'failed' ? 1 : undefined })
    const mailbox = createMailbox(f)
    const completion = f.execute(mailbox.port)
    let finished = false
    void completion.then(() => {
      finished = true
    })
    await mailbox.waiting.promise
    if (status === 'cancelled') {
      f.controller.abort()
      await f.reusable.abort()
    }
    await vi.waitFor(() => expect(mailbox.waitSignals.at(-1)).toBeUndefined())
    expect(finished).toBe(false)
    expect(f.checkpoints()).toEqual(['before'])
    expect(f.runContext.current?.runId).toBe(f.run.id)
    mailbox.finishChildren()
    await expect(completion).resolves.toMatchObject({ status })
    expect(f.requests).toHaveLength(1)
    expect(f.checkpoints()).toEqual(['before', 'after'])
    expect(f.runContext.current).toBeNull()
  })

  it('fails a final checkpoint after a resumed answer instead of reporting an earlier answer as completed', async () => {
    const f = await fixture()
    const mailbox = createMailbox(f, () => {
      renameSync(f.file, `${f.file}.saved`)
      mkdirSync(f.file)
    })
    mailbox.send(f.message('complete-result', 'Final child output'))
    mailbox.finishChildren()
    await expect(f.execute(mailbox.port)).resolves.toMatchObject({ status: 'failed', errorCode: 'SESSION_STORAGE_UNAVAILABLE' })
    expect(f.requests).toHaveLength(2)
    expect(mailbox.consumed).toHaveLength(1)
    expect((await f.eventLog.read(f.run.id)).some(event => event.type === 'session.continuity.degraded')).toBe(false)
    expect(await readFile(`${f.file}.saved`, 'utf8')).toContain('Response 2')
    expect(SessionManager.open(`${f.file}.saved`).getEntries().map(readCheckpoint).filter(Boolean).map(checkpoint => checkpoint!.position)).toEqual(['before'])
    expect(f.runs.findById(f.run.id)?.piSessionFile).toBeNull()
  })
})

async function fixture(options: { compact?: () => void, pending?: () => ExecutionMailboxMessage[], failRequest?: number, toolRounds?: number, delegationReply?: () => { details: unknown, content: { type: 'text', text: string }[] } } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'buddy-execution-continuation-'))
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  const conversations = createConversationRepository(database)
  const runs = createRunRepository(database)
  const eventLog = createRunEventLog({ conversationsDirectory: join(root, 'conversations'), database })
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
  const model = runtime.getModel('openai', 'gpt-4o-mini')!
  await runtime.setRuntimeApiKey(model.provider, 'offline-fixture-only')
  const requests: Context[] = []
  vi.spyOn(runtime, 'streamSimple').mockImplementation((target, context) => {
    requests.push(structuredClone(context))
    return response(target, requests.length, requests.length === options.failRequest, !!options.delegationReply && requests.length <= (options.toolRounds ?? 1), options.compact && requests.length === 1 ? 120000 : 10)
  })
  const now = () => new Date().toISOString()
  conversations.create({ id: 'conversation', branchId: 'branch', spaceId: null, title: null, approvalPolicy: 'policy', executionProfile: 'read_only', createdAt: now() })
  conversations.createMessage({ id: 'initial', conversationId: 'conversation', branchId: 'branch', role: 'user', content: { text: 'Initial input' }, runId: null, createdAt: now() })
  const run = runs.create({ id: 'parent-run', conversationId: 'conversation', branchId: 'branch', triggeringMessageId: 'initial', provider: model.provider, model: model.id, purpose: 'chat', status: 'running', piSessionFile: null, approvalPolicy: 'policy', executionProfile: 'read_only', startedAt: now() })
  const tree = new BuddyConversationTree({ threads: createThreadBindingRepository(database), conversations, runs, conversationsDirectory: join(root, 'conversations'), repository: createConversationTreeRepository(database), recovery: { create: async () => Promise.reject(new Error('Unexpected history recovery')) } })
  const cursor = await tree.open(run, root, model)
  const runContext: BuddyExtensionRunContextStore = { current: null }
  const inputReferences = { pending: null }
  const resources = { skillReadRoots: [], skillReferences: [], approvedSkills: [], context: { agentsFiles: [], diagnostics: [] }, directoryContext: '', revision: 'test' }
  const delegation: BuddyInProcessExtension | undefined = options.delegationReply
    ? {
        name: 'lexora-delegation-fixture',
        factory(pi) {
          pi.registerTool({ name: 'lexora_agents', label: 'Collaboration', description: 'Wait for child result', parameters: Type.Object({ operation: Type.Literal('wait') }), async execute() {
            return options.delegationReply!()
          } })
        },
      }
    : undefined
  const compaction: BuddyInProcessExtension | undefined = options.compact
    ? {
        name: 'lexora-compaction-fixture',
        factory(pi) {
          pi.on('session_before_compact', (event) => {
            options.compact!()
            return { compaction: { summary: 'Preserved task context', firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } }
          })
        },
      }
    : undefined
  const created = await createBuddySession({ agentDir: join(root, 'agent'), branchId: 'branch', canonicalRoot: root, conversationId: 'conversation', conversationsDirectory: join(root, 'conversations'), cwd: root, approvalPolicy: 'policy', executionProfile: 'read_only', inProcessExtensions: [createCompactionTimingExtension(), createInputReferenceExtension(inputReferences), ...compaction ? [compaction] : [], ...delegation ? [delegation] : []], model, modelRuntime: runtime, resources, sessionManager: cursor.manager })
  created.session.settingsManager.applyOverrides({ compaction: { enabled: !!options.compact, keepRecentTokens: 1 } })
  const reusable = createReusableBuddySession({ session: created.session, shutdown: created.shutdown, getPendingExecutionMessages: options.pending
    ? (runId, entries) => {
        const delivered = readExecutionMailboxEntries(entries, { runId, generation: run.generation })
        return options.pending!().filter(message => !delivered.some(entry => entry.message.messageId === message.messageId))
      }
    : undefined, assertModelAccess: async () => model, runContext, inputReferences, materializeInput: async input => [{ type: 'text', text: input.prompt }], tree: cursor })
  reusable.applyPreferences({ cacheWarming: 'off', codemode: false, modelRetryLimit: 0 })
  const sessions = new BuddySessionRegistry<typeof reusable>()
  const piEvents = new PiEventBridge({ eventLog, usage: new UsageService({ eventLog, repository: createUsageRepository(database) }) })
  const executor = new PiTurnExecutor({ eventLog, piEvents, continuity: new RunContinuityService(runs), sessions, sessionFactory: async () => ({ session: reusable, piSessionFile: created.piSessionFile }) })
  const controller = new AbortController()
  const active = new Set<Promise<unknown>>()
  let activeSession: ActiveRunSession | undefined
  const blueprint: BuddySessionBlueprint = { approvalPolicy: 'policy', executionProfile: 'read_only', branchId: run.branchId, conversationId: run.conversationId, canonicalRoot: root, scratchRoot: root, grantRevision: 'test', grants: [], resources, sessionMode: 'interactive', space: null }
  cleanups.push(async () => {
    controller.abort()
    await reusable.abort()
    await Promise.allSettled(active)
    await sessions.dispose()
    await reusable.shutdown('quit')
    await eventLog.close()
    await tree.dispose()
    database.close()
    await rm(root, { recursive: true, force: true })
  })
  return {
    database,
    run,
    runs,
    eventLog,
    reusable,
    runContext,
    session: created.session,
    file: created.piSessionFile,
    requests,
    controller,
    active: () => activeSession,
    checkpoints: () => cursor.manager.getBranch().map(readCheckpoint).filter(Boolean).map(checkpoint => checkpoint!.position),
    turnContext: { runId: run.id, generation: run.generation, provider: model.provider, model: model.id, contextWindow: null, maxTokens: null, signal: controller.signal, flushProjectedEvents: async () => {}, onToolExecutionAuthorized: async () => {}, onToolExecutionDenied: async () => {} },
    message(messageId: string, text: string): ExecutionMailboxMessage {
      const message = { messageId, sourceRunId: 'child-run', sourceSequence: 1, targetRunId: run.id, targetGeneration: run.generation, text, kind: 'result' as const }
      return { ...message, payloadHash: hashExecutionMailboxMessage(message) }
    },
    execute(continuation: ExecutionContinuationPort) {
      const completion = executor.executeTurn({ continuation, identity: toBuddySessionIdentity(blueprint), input: { runId: run.id, session: blueprint, userInput: createBuddyInputReference({ messageId: 'initial', prompt: 'Initial input', images: [] }) }, onSessionActivated: (session) => {
        activeSession = session
      }, onSessionStartupTimeout: () => {}, run, signal: controller.signal, timestamp: now })
      active.add(completion)
      void completion.finally(() => active.delete(completion)).catch(() => {})
      return completion
    },
  }
}

function createMailbox(f: Awaited<ReturnType<typeof fixture>>, onSeal?: () => void) {
  let revision = 0
  let inputs: ExecutionInputState | undefined
  let childrenPending = true
  const messages: ExecutionMailboxMessage[] = []
  const accepted: ExecutionMailboxReceipt[] = []
  const consumed: ExecutionMailboxReceipt[] = []
  const listeners = new Set<() => void>()
  const waiting = Promise.withResolvers<void>()
  const waitSignals: (AbortSignal | undefined)[] = []
  const key = (message: { sourceRunId: string, messageId: string }) => JSON.stringify([message.sourceRunId, message.messageId])
  const remaining = () => messages.filter(message => !consumed.some(receipt => key(receipt) === key(message)))
  function changed() {
    revision++
    for (const listener of listeners)
      listener()
  }
  cleanups.push(async () => {
    childrenPending = false
    changed()
  })
  const port: ExecutionContinuationPort = {
    bindInputs: (state) => {
      inputs = state
      return () => {
        inputs = undefined
      }
    },
    acceptInput: (deliver) => {
      const accepted = deliver()
      if (accepted)
        changed()
      return accepted
    },
    followUp: async () => false,
    readPending: async () => ({ revision, messages: remaining(), shouldResume: remaining().length > 0 }),
    acceptInContext: async (receipts) => {
      const journal = SessionManager.open(f.file).getBranch()
      for (const receipt of receipts) {
        const entry = journal.find(entry => entry.id === receipt.contextEntryId)
        expect(entry).toBeDefined()
        expect(readExecutionMailboxEntries(journal, { runId: f.run.id, generation: f.run.generation })).toEqual(expect.arrayContaining([expect.objectContaining({ contextEntryId: receipt.contextEntryId, message: expect.objectContaining({ sourceRunId: receipt.sourceRunId, messageId: receipt.messageId, payloadHash: receipt.payloadHash }) })]))
        const previous = accepted.find(item => key(item) === key(receipt))
        if (previous)
          expect(receipt).toEqual(previous)
        else
          accepted.push(receipt)
      }
      changed()
    },
    prepareClose: async ({ outcome, consumedReceipts }) => {
      for (const receipt of consumedReceipts) {
        expect(accepted).toContainEqual(receipt)
        if (!consumed.some(previous => key(previous) === key(receipt)))
          consumed.push(receipt)
      }
      if (childrenPending || (outcome.status === 'completed' && (remaining().length || inputs?.hasPendingInput())))
        return { kind: 'pending', revision }
      onSeal?.()
      return { kind: 'sealed', closingGeneration: 7 }
    },
    waitForChange: async ({ afterRevision, signal }) => {
      signal?.throwIfAborted()
      if (afterRevision !== revision)
        return
      waitSignals.push(signal)
      waiting.resolve()
      await new Promise<void>((resolve, reject) => {
        function cleanup() {
          listeners.delete(change)
          signal?.removeEventListener('abort', abort)
        }
        function change() {
          cleanup()
          resolve()
        }
        function abort() {
          cleanup()
          reject(signal!.reason)
        }
        listeners.add(change)
        signal?.addEventListener('abort', abort, { once: true })
      })
    },
  }
  return {
    port,
    accepted,
    consumed,
    waiting,
    waitSignals,
    send(message: ExecutionMailboxMessage) {
      messages.push(message)
      changed()
    },
    finishChildren() {
      childrenPending = false
      changed()
    },
  }
}

function response(model: Model<Api>, index: number, failed: boolean, toolCall = false, inputTokens = 10) {
  const message: AssistantMessage = {
    role: 'assistant',
    api: model.api,
    model: model.id,
    provider: model.provider,
    timestamp: Date.now(),
    content: failed ? [] : toolCall ? [{ type: 'toolCall', id: `wait-${index}`, name: 'lexora_agents', arguments: { operation: 'wait' } }] : [{ type: 'text', text: `Response ${index}` }],
    stopReason: failed ? 'error' : toolCall ? 'toolUse' : 'stop',
    ...(failed ? { errorMessage: '403 forbidden' } : {}),
    usage: { input: inputTokens, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: inputTokens + 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => {
    if (failed)
      stream.push({ type: 'error', reason: 'error', error: message })
    else
      stream.push({ type: 'done', reason: toolCall ? 'toolUse' : 'stop', message })
  })
  return stream
}
