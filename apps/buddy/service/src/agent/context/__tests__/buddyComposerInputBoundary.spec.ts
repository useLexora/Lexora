import type { AssistantMessage, Context, ImageContent, UserMessage } from '@earendil-works/pi-ai'
import type { AgentSession } from '@earendil-works/pi-coding-agent'
import type { BuddyExtensionRunContextStore } from '../../extensions/BuddyExtensionRunContext'
import type { BuddyInProcessExtension } from '../../extensions/BuddyInProcessExtension'
import type { BuddyInputReferenceMessage } from '../BuddyInputReference'
import { Buffer } from 'node:buffer'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { streamSimple } from '@earendil-works/pi-ai/compat'
import { estimateTokens, ModelRuntime } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { afterEach, describe, expect, it } from 'vitest'
import { createOutputPresentationExtension } from '../../../artifacts/outputPresentationExtension'
import { ToolAuthorizationService } from '../../../permissions/ToolAuthorizationService'
import { createInputReferenceExtension } from '../../extensions/inputReferenceExtension'
import { createToolPolicyExtension } from '../../extensions/toolPolicyExtension'
import { createIsolatedBuddySession as createBuddySession } from '../../sessions/__tests__/isolatedBuddySession'
import { createReusableBuddySession } from '../../sessions/createReusableBuddySession'
import {
  createBuddyInputPlaceholderContent,
  createBuddyInputReference,
  readBuddyInputReference,
} from '../BuddyInputReference'

type Stream = ModelRuntime['streamSimple']

interface InputPlan {
  documents?: Array<{ attachmentId: string, mimeType: 'application/pdf' }>
  version: 1
  messageId: string
  text: string
  images: Array<{ snapshotId: string, mimeType: string }>
}

type ReferenceMessage = BuddyInputReferenceMessage

const MARKER_TEXT = '先比较 [IMAGE#1] 与 [IMAGE#2]，再检查 [IMAGE#1]。\n\n[FILE#1: panel-note.txt]\n脱敏面板附件正文。'
const DIRECTORY_CONTEXT = 'Offline workspace context: compare the supplied fixtures only.'
const OUTPUT_GUIDELINE = 'After creating or updating user-facing deliverables with file or shell tools, call lexora_output_present with the exact files or directories the user should receive.'
const directories: string[] = []
const shutdowns: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const shutdown of shutdowns.splice(0).reverse())
    await shutdown()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('composer input at the Buddy session boundary', () => {
  it('omits tool declarations and guidelines for models without tool calling across turns', async () => {
    const fixture = await createFixture({ toolCall: false })
    await fixture.send({ ...plan('plain'), text: 'First turn', images: [] })
    await fixture.send({ ...plan('follow'), text: 'Next turn', images: [] })
    expect(fixture.contexts).toHaveLength(2)
    for (const context of fixture.contexts) {
      expect(context.tools).toEqual([])
      expect(context.systemPrompt).not.toContain(OUTPUT_GUIDELINE)
      expect(context.systemPrompt).toContain(DIRECTORY_CONTEXT)
    }
  })

  it.each(['openai', 'anthropic', 'openai-codex'] as const)('materializes native %s PDFs after payload hooks and restores refs without persisting bytes', async (provider) => {
    const payloads: unknown[] = []
    const capture: Stream = (model, context, options) => streamSimple(model, context, {
      ...options,
      apiKey: model.api === 'openai-codex-responses'
        ? `offline.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'offline-pdf-account' } })).toString('base64url')}.signature`
        : 'offline-test-only',
      fetch: async () => { throw new Error('Unexpected offline transport') },
      onPayload: async (value, requestModel) => {
        payloads.push(await options?.onPayload?.(value, requestModel) ?? value)
        throw new Error('OFFLINE_PAYLOAD_CAPTURED')
      },
    })
    const fixture = await createFixture({ provider, stream: capture })
    const bytes = Buffer.from('%PDF-1.7\nOffline PDF payload fixture\n%%EOF\n')
    await writeFile(join(fixture.root, 'document-1.pdf'), bytes)
    await fixture.send({
      ...plan('pdf-message'),
      images: [],
      documents: [{ attachmentId: 'document-1', mimeType: 'application/pdf' }],
      text: 'Read document-1.pdf',
    })
    const persisted = await readFile(fixture.piSessionFile, 'utf8')
    expect(persisted).toContain('application/pdf')
    expect(persisted).not.toContain(bytes.toString('base64'))
    expect(persisted).not.toContain('buddy-pdf:')
    expect(persisted).toContain('Attachment resources:')
    await fixture.shutdown('quit')
    const restored = await createFixture({ root: fixture.root, piSessionFile: fixture.piSessionFile, provider, stream: capture })
    await restored.send({ ...plan('pdf-followup'), images: [], text: 'Summarize the same PDF again.' })
    expect(payloads).toHaveLength(2)
    for (const payload of payloads) {
      const serialized = JSON.stringify(payload)
      expect(serialized).toContain(bytes.toString('base64'))
      expect(serialized).toContain(provider === 'anthropic' ? 'document' : 'input_file')
      expect(serialized).not.toContain('buddy-pdf:')
      expect(serialized).toContain('native means the original image, PDF, audio, or video is supplied')
      expect(payload).toMatchObject({ metadata: { offline_probe: 'preserved' } })
    }
    await rm(join(fixture.root, 'document-1.pdf'))
    await restored.send({ ...plan('pdf-missing'), images: [], text: 'Retry with a missing PDF.' })
    expect(payloads).toHaveLength(2)
    expect(restored.session.messages.at(-1)).toMatchObject({ errorMessage: 'RESOURCE_MATERIALIZATION_FAILED', stopReason: 'error' })
    await expectSafePersistence(restored)
  })

  it('retains current run preparation for plain, image, and following messages', async () => {
    const fixture = await createFixture()
    await fixture.send({ ...plan('plain'), text: '普通正文', images: [] })
    await fixture.send(plan())
    await fixture.send({ ...plan('follow'), text: '下一轮正文', images: [] })

    expect(fixture.lifecycle.filter(event => event === 'input')).toHaveLength(3)
    expect(fixture.contexts[0]?.systemPrompt).not.toContain('Attachment resources:')
    expect(fixture.contexts[1]?.systemPrompt).toContain('Use supplied native content directly when the task requires understanding the sent snapshot')
    expect(fixture.contexts[2]?.systemPrompt).toContain('Use supplied native content directly when the task requires understanding the sent snapshot')
    for (const [index, id] of ['plain', 'message-1', 'follow'].entries()) {
      expect(fixture.contexts[index]?.systemPrompt).toContain(OUTPUT_GUIDELINE)
      expect(fixture.contexts[index]?.systemPrompt).toContain(`Current offline run: run-${id}`)
    }
    expect(userMessages(fixture.contexts[2]).map(message => message.content)).toEqual([
      [{ type: 'text', text: '普通正文' }],
      materializedContent(fixture),
      [{ type: 'text', text: '下一轮正文' }],
    ])
    await expectSafePersistence(fixture)
  })

  it('fails before transport when a snapshot is missing and permits a new turn after repair', async () => {
    const fixture = await createFixture()
    const blue = fixture.images.get('snapshot-blue')!
    await rm(join(fixture.root, 'snapshot-blue.png'))
    await fixture.send(plan())

    expect(fixture.contexts).toHaveLength(0)
    expect(fixture.session.messages.at(-1)).toMatchObject({
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'RESOURCE_MATERIALIZATION_FAILED',
    })
    expect(fixture.session.isIdle).toBe(true)
    await writeFile(join(fixture.root, 'snapshot-blue.png'), Buffer.from(blue.data, 'base64'))
    await fixture.send({ ...plan('after-repair'), text: '资源已恢复', images: [] })
    expect(userMessages(fixture.contexts[0])[0]?.content).toEqual(materializedContent(fixture))
    expect(fixture.contexts[0]?.systemPrompt).toContain('Current offline run: run-after-repair')
    await expectSafePersistence(fixture)
  })

  it('rematerializes input for a real Buddy tool continuation without appending it again', async () => {
    let calls = 0
    const fixture = await createFixture({
      stream: model => ++calls === 1
        ? terminalStream(model, {
            content: [{ type: 'toolCall', id: 'offline-call-1', name: 'lexora_output_present', arguments: { paths: ['result.txt'] } }],
            stopReason: 'toolUse',
          })
        : terminalStream(model),
    })
    await fixture.send(plan())

    expect(fixture.contexts).toHaveLength(2)
    for (const context of fixture.contexts)
      expect(userMessages(context)[0]?.content).toEqual(materializedContent(fixture))
    expect(fixture.contexts[1]?.messages).toContainEqual(expect.objectContaining({
      role: 'toolResult',
      toolName: 'lexora_output_present',
      details: { artifactIds: ['offline-artifact-1'] },
    }))
    expect(referenceEntries(fixture)).toHaveLength(1)
    await expectSafePersistence(fixture)
  })

  it('keeps native tool-result images outside the Composer input-copy boundary', async () => {
    let calls = 0
    const fixture = await createFixture({
      stream: model => ++calls === 1
        ? terminalStream(model, {
            content: [{ type: 'toolCall', id: 'native-image-call', name: 'lexora_fixture_image', arguments: {} }],
            stopReason: 'toolUse',
          })
        : terminalStream(model),
    })

    await fixture.send(plan())

    expect(fixture.contexts).toHaveLength(2)
    expect(userMessages(fixture.contexts[1])[0]?.content).toEqual(materializedContent(fixture))
    expect(fixture.contexts[1]?.messages).toContainEqual(expect.objectContaining({
      content: [fixture.nativeToolImage],
      role: 'toolResult',
      toolName: 'lexora_fixture_image',
    }))
    expect(referenceEntries(fixture)).toHaveLength(1)
    const persisted = await readFile(fixture.piSessionFile, 'utf8')
    expect(persisted).toContain(fixture.nativeToolImage.data)
    await expectSafePersistence(fixture)
  })

  it('keeps automatic provider retry inside the original prepared turn', async () => {
    let calls = 0
    const fixture = await createFixture({
      stream: model => ++calls === 1
        ? terminalStream(model, { stopReason: 'error', errorMessage: '429 rate limit exceeded' })
        : terminalStream(model),
    })
    fixture.session.settingsManager.applyOverrides({ retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } })
    await fixture.send(plan())

    expect(fixture.contexts).toHaveLength(2)
    expect(fixture.contexts[1]?.systemPrompt).toContain('Current offline run: run-message-1')
    expect(userMessages(fixture.contexts[1])[0]?.content).toEqual(materializedContent(fixture))
    expect(referenceEntries(fixture)).toHaveLength(1)
    expect(fixture.session.messages.at(-1)).toMatchObject({ role: 'assistant', stopReason: 'stop' })
    await expectSafePersistence(fixture)
  })

  it.each(['steer', 'followUp'] as const)('records attachment guidance when the first attachment arrives through %s', async (mode) => {
    const started = Promise.withResolvers<void>()
    const first = createAssistantMessageEventStream()
    let calls = 0
    const fixture = await createFixture({
      stream: (model) => {
        if (++calls > 1)
          return terminalStream(model)
        started.resolve()
        return first
      },
    })
    const sending = fixture.send({ ...plan('plain-first'), text: 'Start with text', images: [] })
    await started.promise
    expect(fixture.reusable[mode]?.(() => toBuddyInputReference(plan('queued-image')))).toBe(true)
    const message = await terminalStream(fixture.session.model!).result()
    first.push({ type: 'done', reason: 'stop', message })
    await sending
    expect(fixture.contexts).toHaveLength(2)
    expect(fixture.contexts[0]?.systemPrompt).not.toContain('Attachment resources:')
    expect(fixture.contexts[1]?.systemPrompt).toContain('Attachment resources:')
    const entries = fixture.session.sessionManager.getEntries().filter(entry => entry.type === 'message' && entry.message.role === 'system' && entry.message.sections?.buddy_attachment_resources)
    expect(entries).toHaveLength(1)
    await expectSafePersistence(fixture)
  })

  it('releases a cancelled run without leaking unconsumed steering into the next run', async () => {
    const started = Promise.withResolvers<void>()
    let calls = 0
    const fixture = await createFixture({
      stream: (model, _context, options) => {
        if (++calls > 1)
          return terminalStream(model)
        const stream = createAssistantMessageEventStream()
        options?.signal?.addEventListener('abort', async () => {
          const aborted = await terminalStream(model, { stopReason: 'aborted' }).result()
          stream.push({ type: 'error', reason: 'aborted', error: aborted })
        }, { once: true })
        started.resolve()
        return stream
      },
    })
    const sending = fixture.send(plan())
    await started.promise
    expect(fixture.reusable.steer?.(() => toBuddyInputReference({ ...plan('pending-steer'), text: 'UNCONSUMED_STEERING', images: [] }))).toBe(true)
    await fixture.reusable.abort()
    await sending
    expect(fixture.runContext.current).toBeNull()
    expect(fixture.session.messages.at(-1)).toMatchObject({ stopReason: 'aborted' })

    await fixture.send({ ...plan('after-cancel'), text: '取消后继续', images: [] })
    expect(fixture.contexts).toHaveLength(2)
    expect(JSON.stringify(fixture.contexts[1]?.messages)).not.toContain('UNCONSUMED_STEERING')
    expect(fixture.contexts[1]?.systemPrompt).toContain(OUTPUT_GUIDELINE)
    expect(fixture.contexts[1]?.systemPrompt).toContain('Current offline run: run-after-cancel')
    await expectSafePersistence(fixture)
  })

  it.each(['openai', 'anthropic'] as const)('preserves actual %s payload order and existing payload transforms', async (provider) => {
    let payload: unknown
    let transports = 0
    const fixture = await createFixture({
      provider,
      stream: (model, context, options) => streamSimple(model, context, {
        ...options,
        apiKey: 'offline-test-only',
        fetch: async () => {
          transports++
          throw new Error('Unexpected offline transport')
        },
        onPayload: async (value, requestModel) => {
          payload = await options?.onPayload?.(value, requestModel) ?? value
          throw new Error('OFFLINE_PAYLOAD_CAPTURED')
        },
      }),
    })
    await fixture.send(plan())

    const images = [...fixture.images.values()]
    if (provider === 'openai') {
      expect(payload).toMatchObject({
        service_tier: 'priority',
        metadata: { offline_probe: 'preserved' },
        input: expect.arrayContaining([{
          role: 'user',
          content: [
            { type: 'input_text', text: MARKER_TEXT },
            ...images.map(image => ({ type: 'input_image', detail: 'auto', image_url: `data:${image.mimeType};base64,${image.data}` })),
          ],
        }]),
      })
    }
    else {
      expect(payload).toMatchObject({
        metadata: { offline_probe: 'preserved' },
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: MARKER_TEXT },
            ...images.map(image => ({ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } })),
          ],
        }],
      })
    }
    expect(transports).toBe(0)
    expect(fixture.contexts[0]?.systemPrompt).toContain(OUTPUT_GUIDELINE)
    expect(fixture.contexts[0]?.systemPrompt).toContain(DIRECTORY_CONTEXT)
    expect(fixture.runContext.current).toBeNull()
    const reference = referenceEntries(fixture)[0]!.message
    expect(estimateTokens(reference)).toBe(estimateTokens({ ...reference, content: materializedContent(fixture) }))
    expect(estimateTokens(reference)).toBeGreaterThan(estimateTokens({ ...reference, content: MARKER_TEXT }) + 2_000)
    expect(JSON.stringify(payload)).not.toContain('buddyInput')
    expect(JSON.stringify(payload)).not.toContain('snapshot-red')
    await expectSafePersistence(fixture)
  })

  it.each(['denied', 'approved_once'] as const)('keeps the read adapter behind product approval: %s', async (decision) => {
    let calls = 0
    const fixture = await createFixture({
      approvalDecision: decision,
      stream: model => terminalStream(model, ++calls === 1
        ? {
            stopReason: 'toolUse',
            content: [{ type: 'toolCall', id: 'read-sensitive', name: 'read', arguments: { path: '.env.media' } }],
          }
        : {}),
    })
    await writeFile(join(fixture.root, '.env.media'), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(32)]))
    await fixture.send({ ...plan(), text: 'Inspect the supplied file', images: [] })
    const result = fixture.contexts[1]?.messages.find(message => message.role === 'toolResult')
    expect(result).toMatchObject({ toolName: 'read', toolCallId: 'read-sensitive', isError: decision === 'denied' })
    if (decision === 'denied') {
      expect(JSON.stringify(result)).toContain('APPROVAL_DENIED')
      expect(JSON.stringify(result)).not.toContain('WAV audio')
    }
    else {
      expect(result).toMatchObject({ details: { contentOmitted: { format: 'WAV audio', sizeBytes: 44 } } })
      expect(JSON.stringify(result)).toContain('no file content was extracted')
    }
  })

  it.each(['manual', 'threshold', 'overflow', 'tree', 'failure', 'cancel'] as const)('projects historical read output through native %s summarization without changing stored entries', async (mode) => {
    let calls = 0
    const fixture = await createFixture({
      contextWindow: mode === 'threshold' ? 10_000 : undefined,
      stream: (model) => {
        calls++
        if (calls === 3 && (mode === 'overflow' || mode === 'failure'))
          return terminalStream(model, { stopReason: 'error', errorMessage: mode === 'overflow' ? 'prompt is too long' : 'offline summary failed' })
        if (calls === 3 && mode === 'cancel')
          queueMicrotask(() => fixture.session.abortCompaction())
        return terminalStream(model, { usage: usage(mode === 'threshold' && calls === 2 ? 9_500 : 0) })
      },
    })
    await fixture.send(plan())
    const branchPoint = fixture.session.sessionManager.getLeafId()!
    const stored = appendHistoricalRead(fixture)
    await fixture.send(plan('message-2'))
    expect(JSON.stringify(fixture.contexts[1])).toContain('Earlier raw file output was omitted')
    expect(JSON.stringify(fixture.contexts[1])).not.toContain('\\u0000')
    enableCompaction(fixture)
    if (mode === 'tree')
      await fixture.session.navigateTree(branchPoint, { summarize: true })
    else if (mode === 'threshold' || mode === 'overflow')
      await fixture.send({ ...plan('follow'), text: 'Continue after compaction', images: [] })
    else if (mode === 'failure' || mode === 'cancel')
      await expect(fixture.session.compact()).rejects.toThrow(mode === 'failure' ? 'offline summary failed' : 'cancelled')
    else
      await fixture.session.compact()
    const summary = fixture.contexts[mode === 'overflow' ? 3 : 2]
    expectSafeSummary(fixture, summary)
    expect(JSON.stringify(summary)).toContain(mode === 'tree' ? '/offline/legacy.wav' : 'Earlier raw file output was omitted')
    expect(JSON.stringify(summary)).not.toContain('\\u0000')
    expect(JSON.stringify(summary)).not.toContain('Showing lines')
    const persisted = (await readFile(fixture.piSessionFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(persisted.find(entry => entry.id === stored.id)).toEqual(stored)
    expect(fixture.session.sessionManager.getEntry(stored.id)).toEqual(stored)
    if (mode === 'failure' || mode === 'cancel')
      expect(fixture.session.sessionManager.getEntries().some(entry => entry.type === 'compaction')).toBe(false)
  })

  it('runs pre-send compaction after an aborted response before preparing the next request', async () => {
    let calls = 0
    const fixture = await createFixture({
      contextWindow: 10_000,
      stream: model => terminalStream(model, ++calls === 1
        ? { stopReason: 'aborted', usage: usage(9_500) }
        : {}),
    })
    enableCompaction(fixture, 1)
    await fixture.send(plan())
    expect(fixture.contexts).toHaveLength(1)
    await fixture.send({ ...plan('after-abort'), text: '预发送压缩后继续', images: [] })

    expect(fixture.lifecycle).toEqual([
      'input',
      'provider',
      'input',
      'compaction_start:threshold',
      'provider',
      'compaction_end:threshold',
      'provider',
    ])
    expectSafeSummary(fixture, fixture.contexts[1])
    expect(fixture.contexts[2]?.systemPrompt).toContain('Current offline run: run-after-abort')
    expect(userMessages(fixture.contexts[2]).at(-1)?.content).toEqual([{ type: 'text', text: '预发送压缩后继续' }])
    await expectSafePersistence(fixture)
  })

  it('uses native manual compaction and rematerializes only retained inputs', async () => {
    const fixture = await createFixture()
    await fixture.send(plan())
    await fixture.send(plan('message-2'))
    enableCompaction(fixture)
    const second = referenceEntries(fixture)[1]!
    const result = await fixture.session.compact()

    expect(result.firstKeptEntryId).toBe(second.id)
    expectSafeSummary(fixture, fixture.contexts[2])
    await fixture.send({ ...plan('follow'), text: '压缩后继续', images: [] })
    expect(imageMessages(fixture.contexts[3]).map(message => message.content)).toEqual([materializedContent(fixture)])
    await expectSafePersistence(fixture)
  })

  it('compacts and retries overflow without appending a second user input', async () => {
    let calls = 0
    const fixture = await createFixture({
      stream: model => terminalStream(model, ++calls === 2
        ? { stopReason: 'error', errorMessage: 'prompt is too long' }
        : {}),
    })
    enableCompaction(fixture)
    await fixture.send(plan())
    await fixture.send(plan('message-2'))

    expect(fixture.contexts).toHaveLength(4)
    expectSafeSummary(fixture, fixture.contexts[2])
    expect(imageMessages(fixture.contexts[3]).map(message => message.content)).toEqual([materializedContent(fixture)])
    expect(referenceEntries(fixture)).toHaveLength(2)
    expect(fixture.lifecycle).toContain('compaction_end:overflow')
    await expectSafePersistence(fixture)
  })

  it.each(['cancel', 'failure'] as const)('preserves inputs after manual compaction %s', async (mode) => {
    let calls = 0
    const fixture = await createFixture({
      stream: (model) => {
        if (++calls !== 3)
          return terminalStream(model)
        if (mode === 'cancel')
          queueMicrotask(() => fixture.session.abortCompaction())
        return terminalStream(model, mode === 'failure'
          ? { stopReason: 'error', errorMessage: 'offline summary failed' }
          : {})
      },
    })
    await fixture.send(plan())
    await fixture.send(plan('message-2'))
    enableCompaction(fixture)
    await expect(fixture.session.compact()).rejects.toThrow(mode === 'cancel' ? 'cancelled' : 'offline summary failed')
    expectSafeSummary(fixture, fixture.contexts[2])
    await fixture.send({ ...plan('follow'), text: '摘要未成功，继续', images: [] })
    expect(imageMessages(fixture.contexts[3])).toHaveLength(2)
    await expectSafePersistence(fixture)
  })

  it('summarizes an abandoned branch without image bytes and reloads only the active branch', async () => {
    const fixture = await createFixture()
    await fixture.send(plan())
    const branchPoint = fixture.session.sessionManager.getLeafId()!
    await fixture.send(plan('abandoned'))
    const navigation = await fixture.session.navigateTree(branchPoint, { summarize: true })

    expect(navigation.summaryEntry?.type).toBe('branch_summary')
    expectSafeSummary(fixture, fixture.contexts[2])
    expect(referenceEntries(fixture).map(entry => entry.message.buddyInput.messageId)).toEqual(['message-1'])
    await fixture.shutdown('quit')
    const reloaded = await createFixture({ root: fixture.root, piSessionFile: fixture.piSessionFile })
    await reloaded.send({ ...plan('follow'), text: '当前分支继续', images: [] })
    expect(imageMessages(reloaded.contexts[0]).map(message => message.content)).toEqual([materializedContent(reloaded)])
    await expectSafePersistence(reloaded)
  })
})

async function createFixture(options: {
  root?: string
  piSessionFile?: string
  provider?: 'openai' | 'anthropic' | 'openai-codex'
  approvalDecision?: 'denied' | 'approved_once'
  contextWindow?: number
  toolCall?: boolean
  stream?: Stream
} = {}) {
  const root = options.root ?? await mkdtemp(join(tmpdir(), 'buddy-composer-s0-'))
  if (!options.root)
    directories.push(root)
  const credentials = new InMemoryCredentialStore()
  if (options.provider === 'openai-codex') {
    await credentials.modify('openai-codex', async () => ({
      type: 'oauth',
      access: 'offline-test-only',
      refresh: 'offline-refresh-only',
      expires: Date.now() + 60_000,
    }))
  }
  const modelRuntime = await ModelRuntime.create({
    credentials,
    modelsPath: null,
    refreshOnCreate: false,
  })
  const provider = options.provider ?? 'openai'
  if (provider !== 'openai-codex')
    await modelRuntime.setRuntimeApiKey(provider, 'offline-test-only')
  const catalogModel = modelRuntime.getModel(provider, provider === 'openai' ? 'gpt-4o-mini' : provider === 'openai-codex' ? 'gpt-5.5' : 'claude-sonnet-4-5')
  if (!catalogModel)
    throw new Error('Missing installed model fixture')
  const model = { ...catalogModel, pdfInput: true, toolCall: options.toolCall, contextWindow: options.contextWindow ?? catalogModel.contextWindow }
  const runContext: BuddyExtensionRunContextStore = { current: null }
  const images = new Map([
    ['snapshot-red', png([255, 0, 0, 255])],
    ['snapshot-blue', png([0, 0, 255, 255])],
  ])
  const nativeToolImage = png([0, 255, 0, 255])
  if (!options.piSessionFile) {
    for (const [id, image] of images)
      await writeFile(join(root, `${id}.png`), Buffer.from(image.data, 'base64'))
  }
  const contexts: Context[] = []
  const lifecycle: string[] = []
  const inputReferences = { pending: null }
  const probe: BuddyInProcessExtension = {
    name: 'lexora-composer-offline-probe',
    factory(pi) {
      pi.on('input', () => {
        lifecycle.push('input')
      })
      pi.on('before_provider_request', event => ({ ...new Object(event.payload), metadata: { offline_probe: 'preserved' } }))
      pi.on('before_agent_start', (event) => {
        event.systemPromptOptions.sections.offline_run = `Current offline run: ${runContext.current?.runId}`
      })
    },
  }
  let reusable: ReturnType<typeof createReusableBuddySession> | undefined
  const created = await createBuddySession({
    getInputMessages: () => reusable?.getInputContext?.().messages ?? [],
    agentDir: join(root, 'agent'),
    approvalPolicy: 'policy',
    branchId: 'branch-1',
    canonicalRoot: root,
    conversationId: 'conversation-1',
    conversationsDirectory: join(root, 'conversations'),
    cwd: root,
    executionProfile: 'workspace_write',
    getServiceTier: () => runContext.current?.serviceTier ?? null,
    getPendingInput: () => inputReferences.pending,
    inProcessExtensions: [
      ...options.approvalDecision
        ? [createToolPolicyExtension({
            authorization: new ToolAuthorizationService({
              approvalAvailable: true,
              approvalPolicy: 'policy',
              approvalService: { request: async () => ({ approvalId: 'offline-approval', decision: options.approvalDecision! }) },
              cwd: root,
              executionProfile: 'workspace_write',
              getGrants: () => [{ canonicalRoot: root, root, grantId: 'workspace', kind: 'workspace' }],
              owner: { kind: 'conversation', id: 'conversation-1' },
            }),
            getRunContext: () => runContext.current,
          })]
        : [],
      createInputReferenceExtension(inputReferences),
      createOutputPresentationExtension({
        artifactService: { presentOutputs: async () => [{ id: 'offline-artifact-1' }] },
        conversationId: 'conversation-1',
        cwd: root,
        getRunId: () => runContext.current?.runId,
        grants: [],
      }),
      {
        name: 'lexora-fixture-image',
        factory(pi) {
          pi.registerTool({
            description: 'Return an offline image fixture.',
            async execute() {
              return { content: [nativeToolImage], details: undefined }
            },
            label: 'Fixture image',
            name: 'lexora_fixture_image',
            parameters: Type.Object({}, { additionalProperties: false }),
          })
        },
      },
      probe,
    ],
    model,
    modelRuntime,
    piSessionFile: options.piSessionFile,
    resources: {
      skillReadRoots: [],
      skillReferences: [],
      approvedSkillPaths: [],
      context: { agentsFiles: [], diagnostics: [] },
      directoryContext: DIRECTORY_CONTEXT,
      revision: 'offline-s0',
    },
  })
  const { session } = created
  shutdowns.push(() => created.shutdown('quit'))
  session.settingsManager.setRetryEnabled(false)
  session.settingsManager.setCompactionEnabled(false)
  session.subscribe((event) => {
    if (event.type === 'compaction_start' || event.type === 'compaction_end')
      lifecycle.push(`${event.type}:${event.reason}`)
  })
  modelRuntime.streamSimple = (requestModel, context, streamOptions) => {
    const emptyImage = userMessages(context).some(message => (
      Array.isArray(message.content)
      && message.content.some(block => block.type === 'image' && !block.data)
    ))
    if (emptyImage) {
      return terminalStream(requestModel, {
        content: [],
        errorMessage: 'RESOURCE_MATERIALIZATION_FAILED',
        stopReason: 'error',
      })
    }
    contexts.push(structuredClone({
      systemPrompt: getCurrentSystemPrompt(context.messages),
      tools: getCurrentTools(context.messages),
      messages: context.messages.filter(message => message.role !== 'system'),
    }))
    lifecycle.push('provider')
    return options.stream?.(requestModel, context, streamOptions) ?? terminalStream(requestModel)
  }
  reusable = createReusableBuddySession({
    assertModelAccess: async () => model,
    inputReferences,
    materializeDocuments: async input => Promise.all((input.documents ?? []).map(async reference => ({
      data: (await readFile(join(root, `${reference.attachmentId}.pdf`))).toString('base64'),
      name: `${reference.attachmentId}.pdf`,
      mimeType: reference.mimeType,
    }))),
    materializeInput: async (input) => {
      const content: UserMessage['content'] = [{ type: 'text', text: input.prompt }]
      for (const reference of input.images) {
        const image = images.get(reference.attachmentId)
        if (!image || image.mimeType !== reference.mimeType)
          throw new Error('RESOURCE_MATERIALIZATION_FAILED')
        const bytes = await readFile(join(root, `${reference.attachmentId}.png`))
        content.push({ type: 'image', mimeType: reference.mimeType, data: bytes.toString('base64') })
      }
      return content
    },
    runContext,
    session,
    shutdown: created.shutdown,
  })

  async function send(input: InputPlan, runId = `run-${input.messageId}`) {
    const reference = toBuddyInputReference(input)
    const existing = session.sessionManager.getBranch().find(entry => (
      entry.type === 'message' && isReferenceMessage(entry.message)
      && entry.message.buddyInput.messageId === input.messageId
    ))
    if (existing?.type === 'message' && isReferenceMessage(existing.message)) {
      if (JSON.stringify(existing.message.buddyInput) !== JSON.stringify(reference))
        throw new Error('MESSAGE_SNAPSHOT_MISMATCH')
      return false
    }
    const release = await reusable!.activateTurn({
      contextWindow: null,
      flushProjectedEvents: async () => {},
      maxTokens: null,
      model: model!.id,
      onToolExecutionAuthorized: async () => {},
      onToolExecutionDenied: async () => {},
      provider: model!.provider,
      runId,
      serviceTier: 'priority',
      signal: new AbortController().signal,
    })
    try {
      await reusable!.prompt(input.text, {
        expandPromptTemplates: false,
        images: referenceImages(input),
        inputReference: reference,
        source: 'rpc',
      })
      return true
    }
    finally {
      release()
    }
  }

  return { ...created, contexts, images, lifecycle, nativeToolImage, reusable, root, runContext, send }
}

function appendHistoricalRead(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const model = fixture.session.model!
  fixture.session.sessionManager.appendMessage({
    api: model.api,
    provider: model.provider,
    model: model.id,
    role: 'assistant',
    stopReason: 'toolUse',
    timestamp: Date.now(),
    usage: usage(),
    content: [{ type: 'toolCall', id: 'legacy-read', name: 'read', arguments: { path: '/offline/legacy.wav' } }],
  })
  const text = `RIFF\0\0\0\0WAVE${'\0'.repeat(40_782)}\n[Showing lines 1-7 of 3545]`
  const id = fixture.session.sessionManager.appendMessage({
    role: 'toolResult',
    toolCallId: 'legacy-read',
    toolName: 'read',
    timestamp: Date.now(),
    isError: false,
    content: [{ type: 'text', text }],
    details: { truncation: { content: text, truncated: true } },
  })
  fixture.session.agent.state.messages = fixture.session.sessionManager.buildSessionContext().messages
  return structuredClone(fixture.session.sessionManager.getEntry(id)!)
}

function referenceImages(input: InputPlan): ImageContent[] {
  return createBuddyInputPlaceholderContent(toBuddyInputReference(input)).slice(1) as ImageContent[]
}

function isReferenceMessage(message: AgentSession['messages'][number]): message is ReferenceMessage {
  return readBuddyInputReference(message) !== null
}

function toBuddyInputReference(input: InputPlan) {
  return createBuddyInputReference({
    ...(input.documents?.length ? { documents: input.documents } : {}),
    images: input.images.map(image => ({
      attachmentId: image.snapshotId,
      mimeType: image.mimeType,
    })),
    messageId: input.messageId,
    prompt: input.text,
  })
}

function plan(messageId = 'message-1'): InputPlan {
  return {
    version: 1,
    messageId,
    text: MARKER_TEXT,
    images: [
      { snapshotId: 'snapshot-red', mimeType: 'image/png' },
      { snapshotId: 'snapshot-blue', mimeType: 'image/png' },
    ],
  }
}

function png(pixel: number[]): ImageContent {
  const data = pixel[0] === 255
    ? 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4AQEJAPb/AP8AAP//AAD/EfcD/d750N0AAAAASUVORK5CYII='
    : pixel[1] === 255
      ? 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAADElEQVR4nGNg+A+BAA/5A/3YOXFBAAAAAElFTkSuQmCC'
      : 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAFElEQVR4AQEJAPb/AAAA//8AAP//DfsD/dj9ysUAAAAASUVORK5CYII='
  return { data, mimeType: 'image/png', type: 'image' }
}

function terminalStream(model: Parameters<Stream>[0], override: Partial<AssistantMessage> = {}) {
  const message: AssistantMessage = {
    api: model.api,
    content: [{ type: 'text', text: 'Offline response.' }],
    model: model.id,
    provider: model.provider,
    role: 'assistant',
    stopReason: 'stop',
    timestamp: Date.now(),
    usage: usage(),
    ...override,
  }
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => {
    if (message.stopReason === 'error' || message.stopReason === 'aborted')
      stream.push({ type: 'error', error: message, reason: message.stopReason })
    else
      stream.push({ type: 'done', message, reason: message.stopReason === 'toolUse' ? 'toolUse' : 'stop' })
  })
  return stream
}

function usage(totalTokens = 0): AssistantMessage['usage'] {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
}

function userMessages(context?: Context) {
  return context?.messages.filter(message => message.role === 'user') ?? []
}

function imageMessages(context?: Context) {
  return userMessages(context).filter(message => (
    Array.isArray(message.content) && message.content.some(block => block.type === 'image')
  ))
}

function enableCompaction(fixture: Awaited<ReturnType<typeof createFixture>>, keepRecentTokens = 1_200) {
  fixture.session.settingsManager.applyOverrides({
    compaction: { enabled: true, keepRecentTokens, reserveTokens: 1_000 },
  })
}

function expectSafeSummary(fixture: Awaited<ReturnType<typeof createFixture>>, context?: Context) {
  expect(context).toBeDefined()
  expect(imageMessages(context)).toHaveLength(0)
  expect(JSON.stringify(context)).toContain(MARKER_TEXT.split('\n')[0])
  for (const image of fixture.images.values())
    expect(JSON.stringify(context)).not.toContain(image.data)
}

function materializedContent(fixture: Awaited<ReturnType<typeof createFixture>>): UserMessage['content'] {
  return [{ type: 'text', text: MARKER_TEXT }, ...fixture.images.values()]
}

function referenceEntries(fixture: Awaited<ReturnType<typeof createFixture>>) {
  return fixture.session.sessionManager.getBranch().flatMap(entry => (
    entry.type === 'message' && isReferenceMessage(entry.message) ? [{ ...entry, message: entry.message }] : []
  ))
}

async function expectSafePersistence(fixture: Awaited<ReturnType<typeof createFixture>>) {
  const jsonl = await readFile(fixture.piSessionFile, 'utf8')
  for (const image of fixture.images.values()) {
    expect(jsonl).not.toContain(image.data)
    expect(JSON.stringify(fixture.session.messages)).not.toContain(image.data)
  }
  expect(jsonl).toContain('"buddyInput"')
  expect(jsonl).not.toContain('data:image')
}
