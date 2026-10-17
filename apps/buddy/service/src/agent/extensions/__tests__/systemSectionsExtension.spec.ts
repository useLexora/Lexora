import type { Api, AssistantMessage, Context, ImageContent, Model } from '@earendil-works/pi-ai'
import type { BeforeAgentStartEvent } from '@earendil-works/pi-coding-agent'
import type { BuddyInputReferenceStore } from '../../context/BuddyInputReference'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessageEventStream, getCurrentSystemMessage, getCurrentTools, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBuddyInputReference, createBuddyInputReferenceMessage } from '../../context/BuddyInputReference'
import { createIsolatedBuddySession } from '../../sessions/__tests__/isolatedBuddySession'
import { createInputReferenceExtension } from '../inputReferenceExtension'

const cleanups: (() => Promise<void>)[] = []
const actor = 'SYSTEM_SECTIONS_ACTOR'
const guideline = 'SYSTEM_SECTIONS_TOOL_GUIDELINE'
const customMessage = { customType: 'lexora.execution.resume.v1', content: 'Continue from delivered source material, not new authorization.', display: false }
const image: ImageContent = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' }

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

describe('buddy system sections at the native Pi start boundary', () => {
  it('includes native images in the user attachment sections', async () => {
    const f = await fixture()
    await f.session.prompt('User input', { images: [image] })
    expect(f.starts[0]?.messageType).toBe('user')
    expect(f.starts[0]?.systemPromptOptions.sections.buddy_attachment_resources).toContain('Attachment resources:')
    expectSections(f.requests[0]!)
    expect(f.session.messages.filter(message => message.role === 'user')).toHaveLength(1)
  })

  it('uses the pending user reference before binding it to the journal', async () => {
    const f = await fixture()
    f.inputs.pending = createBuddyInputReference({ messageId: 'user-with-attachment', prompt: 'Use the attached document', images: [], attachmentIds: ['document-snapshot'] })
    await f.session.prompt(f.inputs.pending.prompt)
    expect(f.starts[0]?.systemPromptOptions.sections.buddy_attachment_resources).toContain('Attachment resources:')
    expect(f.inputs.pending).toBeNull()
    expect(f.session.messages.filter(message => message.role === 'user')).toMatchObject([{ buddyInput: { messageId: 'user-with-attachment', attachmentIds: ['document-snapshot'] } }])
    expectSections(f.requests[0]!)
  })

  it('keeps custom starts separate from pending user references while assembling current sections', async () => {
    const f = await fixture()
    const pending = createBuddyInputReference({ messageId: 'not-submitted', prompt: 'Do not borrow this input', images: [], attachmentIds: ['unrelated-snapshot'] })
    f.inputs.pending = pending
    await f.session.sendCustomMessage({ ...customMessage, content: '<attachment_resources>Custom source is not a user attachment</attachment_resources>' }, { triggerTurn: true })
    expect(f.starts[0]?.messageType).toBe('custom')
    expect(f.starts[0]?.systemPromptOptions.sections.buddy_attachment_resources).toBe('')
    expectSections(f.requests[0]!)
    expect(getCurrentSystemMessage(f.requests[0]!.messages)?.sections?.buddy_attachment_resources).toBeFalsy()
    expect(f.session.messages.some(message => message.role === 'user')).toBe(false)
    expect(f.session.messages.filter(message => message.role === 'custom')).toHaveLength(1)
    expect(f.inputs.pending).toBe(pending)
    expect(JSON.stringify(f.session.sessionManager.getBranch())).not.toContain('not-submitted')
  })

  it('retains real historical attachment context for a custom continuation without adding a user message', async () => {
    const f = await fixture()
    const previous = createBuddyInputReferenceMessage(createBuddyInputReference({ messageId: 'previous-user', prompt: 'Existing attachment', images: [], attachmentIds: ['previous-snapshot'] }), 1)
    f.session.sessionManager.appendMessage(previous)
    f.session.refreshContext()
    await f.session.sendCustomMessage(customMessage, { triggerTurn: true })
    expect(f.starts[0]?.systemPromptOptions.sections.buddy_attachment_resources).toContain('Attachment resources:')
    expect(f.session.messages.filter(message => message.role === 'user')).toEqual([previous])
    expectSections(f.requests[0]!)
  })

  it.each(['user', 'custom'] as const)('queues messages instead of reentering while a %s start hook is busy', async (kind) => {
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const f = await fixture(async () => {
      entered.resolve()
      await gate.promise
    })
    const running = start(f.session, kind)
    try {
      await entered.promise
      expect(f.session.isStreaming).toBe(true)
      expect(f.session.isIdle).toBe(false)
      await expect(f.session.prompt('Do not start a second run')).rejects.toThrow('already processing')
      await f.session.sendCustomMessage({ ...customMessage, customType: 'queued-source', content: 'Queued during start' }, { triggerTurn: true })
      expect(f.starts).toHaveLength(1)
    }
    finally {
      gate.resolve()
      await running
    }
    expect(f.session.isIdle).toBe(true)
    expect(f.session.messages.filter(message => message.role === 'custom' && message.customType === 'queued-source')).toHaveLength(1)
    expect(f.session.messages.filter(message => message.role === 'user')).toHaveLength(kind === 'user' ? 1 : 0)
    expect(f.requests.length).toBeGreaterThan(0)
    expect(f.requests.every(context => getCurrentSystemMessage(context.messages)?.sections?.buddy_actor?.includes(actor))).toBe(true)
  })

  it.each(['user', 'custom'] as const)('honors cancellation during a %s start and permits a clean later run', async (kind) => {
    const entered = Promise.withResolvers<void>()
    const gate = Promise.withResolvers<void>()
    const f = await fixture(async () => {
      entered.resolve()
      await gate.promise
    })
    const running = start(f.session, kind)
    await entered.promise
    const aborting = f.session.abort()
    gate.resolve()
    await Promise.all([running, aborting])
    expect(f.session.isIdle).toBe(true)
    expect(f.abortedRequests).toEqual([true])
    expect(f.session.messages.some(message => message.role === 'assistant' && message.stopReason === 'aborted')).toBe(true)
    await f.session.sendCustomMessage({ ...customMessage, content: 'Clean later continuation' }, { triggerTurn: true })
    expect(f.abortedRequests).toEqual([true, false])
    expectSections(f.requests[1]!)
    expect(f.session.isIdle).toBe(true)
  })
})

function start(session: Awaited<ReturnType<typeof fixture>>['session'], kind: 'user' | 'custom') {
  return kind === 'user' ? session.prompt('Initial user input') : session.sendCustomMessage(customMessage, { triggerTurn: true })
}

function expectSections(context: Context) {
  const sections = getCurrentSystemMessage(context.messages)?.sections
  expect(sections?.buddy_actor).toContain(actor)
  expect(sections?.buddy_tool_guidelines).toContain(guideline)
  expect(sections?.buddy_permissions).toContain('full access')
  expect(sections?.start_probe).toContain('PRESERVED_EXTERNAL_SECTION')
  expect(getCurrentTools(context.messages).map(tool => tool.name)).toContain('lexora_sections_probe')
}

async function fixture(beforeStart?: () => Promise<void>) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-system-sections-')))
  cleanups.push(() => rm(root, { force: true, recursive: true }))
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
  const model = runtime.getModels().find(model => model.provider === 'anthropic')!
  await runtime.setRuntimeApiKey(model.provider, 'offline-test-only')
  const inputs: BuddyInputReferenceStore = { pending: null }
  const starts: BeforeAgentStartEvent[] = []
  const requests: Context[] = []
  const abortedRequests: boolean[] = []
  vi.spyOn(runtime, 'streamSimple').mockImplementation((target, context, options) => {
    requests.push(structuredClone(context))
    const aborted = options?.signal?.aborted ?? false
    abortedRequests.push(aborted)
    return response(target, aborted)
  })
  const created = await createIsolatedBuddySession({
    agentDir: join(root, 'agent'),
    branchId: 'branch-1',
    canonicalRoot: root,
    conversationId: 'conversation-1',
    conversationsDirectory: join(root, 'conversations'),
    cwd: root,
    approvalPolicy: 'policy',
    executionProfile: 'full_access',
    model,
    modelRuntime: runtime,
    getPendingInput: () => inputs.pending,
    inProcessExtensions: [
      createInputReferenceExtension(inputs),
      {
        name: 'lexora-sections-probe',
        factory(pi) {
          pi.registerTool({
            name: 'lexora_sections_probe',
            label: 'Sections probe',
            description: 'Offline system sections fixture',
            parameters: Type.Object({}),
            promptGuidelines: [guideline],
            async execute() { return { content: [{ type: 'text', text: 'ok' }], details: {} } },
          })
          pi.on('before_agent_start', async (event) => {
            starts.push(event)
            event.systemPromptOptions.sections.start_probe = 'PRESERVED_EXTERNAL_SECTION'
            await beforeStart?.()
          })
        },
      },
    ],
    resources: { actorPrompt: actor, skillReadRoots: [], skillReferences: [], approvedSkills: [], context: { agentsFiles: [], diagnostics: [] }, directoryContext: '', revision: 'empty' },
  })
  cleanups.push(() => created.shutdown('quit'))
  return { session: created.session, inputs, starts, requests, abortedRequests }
}

function response(model: Model<Api>, aborted: boolean) {
  const message: AssistantMessage = {
    api: model.api,
    model: model.id,
    provider: model.provider,
    role: 'assistant',
    timestamp: Date.now(),
    stopReason: aborted ? 'aborted' : 'stop',
    content: aborted ? [] : [{ type: 'text', text: 'Done' }],
    usage: { input: 10, output: 10, totalTokens: 20, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => stream.push(aborted ? { type: 'error', reason: 'aborted', error: message } : { type: 'done', reason: 'stop', message }))
  return stream
}
