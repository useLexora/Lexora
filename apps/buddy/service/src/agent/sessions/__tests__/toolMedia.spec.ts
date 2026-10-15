import type { Api, AssistantMessage, Context, Model, ToolCall } from '@earendil-works/pi-ai'
import { Buffer } from 'node:buffer'
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { createCodemodeExtension, ModelRuntime } from '@earendil-works/pi-coding-agent'
import { PhotonImage } from '@silvia-odwyer/photon-node'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { conversationImageDirectory } from '../../../attachments/ImageBlobStore'
import { CODEMODE_EXTENSION } from '../../extensions/codemodeExtension'
import { createReusableBuddySession } from '../createReusableBuddySession'
import { createIsolatedBuddySession } from './isolatedBuddySession'

const pixels = new PhotonImage(new Uint8Array(8 * 4 * 4).fill(255), 8, 4)
const png = Buffer.from(pixels.get_bytes())
pixels.free()
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

describe('pi tool media persistence', () => {
  it('keeps one immutable binary snapshot through repeated reads, restart, deleted source and copied data root', async () => {
    const fixture = await createFixture()
    let created = await fixture.open()
    await fixture.turn(created, { name: 'read', arguments: { path: fixture.source } })
    const image = images(fixture.requests.at(-1)!).at(-1)!
    expect(Buffer.from(image.data, 'base64').subarray(0, 8)).toEqual(png.subarray(0, 8))
    await fixture.turn(created, { name: 'read', arguments: { path: fixture.source } })
    const journal = await readFile(created.piSessionFile, 'utf8')
    expect(journal).not.toContain(image.data)
    expect(journal).toContain('buddyToolMedia')
    expect(await readdir(fixture.blobs)).toHaveLength(1)
    const saved = created.session.messages.filter(message => message.role === 'toolResult')
    expect(saved.every(message => message.content.some(block => block.type === 'image' && block.data === ''))).toBe(true)
    await created.shutdown('quit')
    await rm(fixture.source)
    created = await fixture.open(created.piSessionFile)
    await fixture.turn(created)
    expect(images(fixture.requests.at(-1)!)).toEqual([image, image])
    expect(await readFile(created.piSessionFile, 'utf8')).not.toContain(image.data)
    await created.shutdown('quit')
    const restored = join(fixture.root, 'restored')
    await cp(fixture.conversations, restored, { recursive: true })
    const restoredFile = created.piSessionFile.replace(fixture.conversations, restored)
    await rm(fixture.conversations, { recursive: true })
    created = await fixture.open(restoredFile, restored)
    await fixture.turn(created)
    expect(images(fixture.requests.at(-1)!)).toEqual([image, image])
  })

  it('preserves the typed read result used by Code Mode and externalizes its emitted image', async () => {
    const fixture = await createFixture()
    const created = await fixture.open()
    await fixture.turn(created, { name: 'codemode', arguments: { code: `const result = await tools.read({ path: ${JSON.stringify(fixture.source)} }); image(result);` } })
    expect(created.session.messages.findLast(message => message.role === 'toolResult')).toMatchObject({ toolName: 'codemode', isError: false, buddyToolMedia: { version: 1 } })
    expect(images(fixture.requests.at(-1)!)).toHaveLength(1)
    expect(await readFile(created.piSessionFile, 'utf8')).not.toContain(images(fixture.requests.at(-1)!)[0]!.data)
  })

  it('blocks missing or corrupted referenced bytes before making a model request', async () => {
    const fixture = await createFixture()
    const created = await fixture.open()
    await fixture.turn(created, { name: 'read', arguments: { path: fixture.source } })
    const before = fixture.requests.length
    const [hash] = await readdir(fixture.blobs)
    await writeFile(join(fixture.blobs, hash!), 'changed')
    await fixture.turn(created).catch(() => {})
    expect(fixture.requests).toHaveLength(before)
    const last = created.session.messages.at(-1)
    expect(last).toMatchObject({ role: 'assistant', stopReason: 'error' })
    await created.session.setModel({ ...fixture.model, input: ['text'] })
    await fixture.turn(created)
    expect(fixture.requests).toHaveLength(before + 1)
    expect(images(fixture.requests.at(-1)!)).toEqual([])
  })

  it('retains a complete inline result if binary publication fails instead of persisting a dangling reference', async () => {
    const fixture = await createFixture()
    const created = await fixture.open()
    await mkdir(join(fixture.conversations, 'media-conversation'), { recursive: true })
    await writeFile(join(fixture.conversations, 'media-conversation/media'), 'blocked-directory')
    await fixture.turn(created, { name: 'read', arguments: { path: fixture.source } })
    const image = images(fixture.requests.at(-1)!)[0]!
    expect(image.data).not.toBe('')
    const persisted = await readFile(created.piSessionFile, 'utf8')
    expect(persisted).toContain(image.data)
    expect(persisted).not.toContain('buddyToolMedia')
  })

  it('keeps durable media through native compaction without sending empty images to the summarizer', async () => {
    const fixture = await createFixture()
    const created = await fixture.open()
    await fixture.turn(created, { name: 'read', arguments: { path: fixture.source } })
    const [hash] = await readdir(fixture.blobs)
    const bytes = await readFile(join(fixture.blobs, hash!))
    await fixture.turn(created)
    created.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1, reserveTokens: 1 } })
    await created.session.compact('Preserve the relevant facts.')
    expect(created.session.sessionManager.getEntries().some(entry => entry.type === 'compaction')).toBe(true)
    expect(fixture.requests.every(request => images(request).every(image => !!image.data))).toBe(true)
    await fixture.turn(created)
    expect(await readFile(join(fixture.blobs, hash!))).toEqual(bytes)
    expect(await readFile(created.piSessionFile, 'utf8')).toContain('buddyToolMedia')
  })

  it('restores only the images belonging to the selected native branch', async () => {
    const fixture = await createFixture()
    const created = await fixture.open()
    await fixture.turn(created, { name: 'read', arguments: { path: fixture.source } })
    const checkpoint = created.session.sessionManager.getLeafId()!
    await fixture.turn(created, { name: 'read', arguments: { path: fixture.source } })
    expect(images(fixture.requests.at(-1)!)).toHaveLength(2)
    await created.session.navigateTree(checkpoint, { summarize: false })
    await fixture.turn(created)
    expect(images(fixture.requests.at(-1)!)).toHaveLength(1)
    expect(await readdir(fixture.blobs)).toHaveLength(1)
  })
})

async function createFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-tool-media-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'image.png')
  await writeFile(source, png)
  const conversations = join(root, 'conversations')
  const blobs = conversationImageDirectory(join(conversations, 'media-conversation'))
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
  const model: Model<Api> = { ...runtime.getModels().find(model => model.provider === 'openai')!, input: ['text', 'image'] }
  await runtime.setRuntimeApiKey(model.provider, 'offline-only')
  let nextCall: Pick<ToolCall, 'name' | 'arguments'> | undefined
  let callId = 0
  const requests: Context[] = []
  vi.spyOn(runtime, 'streamSimple').mockImplementation((target, context) => {
    requests.push(structuredClone(context))
    const call = nextCall
    nextCall = undefined
    return response(target, call, ++callId)
  })
  return {
    root,
    source,
    conversations,
    blobs,
    requests,
    model,
    async open(piSessionFile?: string, conversationsDirectory = conversations) {
      const created = await createIsolatedBuddySession({
        agentDir: join(root, 'agent'),
        canonicalRoot: root,
        cwd: root,
        conversationsDirectory,
        conversationId: 'media-conversation',
        branchId: 'media-branch',
        piSessionFile,
        approvalPolicy: 'policy',
        executionProfile: 'workspace_write',
        model,
        modelRuntime: runtime,
        thinkingLevel: 'off',
        resources: { skillReadRoots: [], skillReferences: [], approvedSkills: [], context: { agentsFiles: [], diagnostics: [] }, directoryContext: '', revision: 'empty' },
        inProcessExtensions: [{ name: CODEMODE_EXTENSION, factory: createCodemodeExtension({ mode: 'on', models: false }) }],
      })
      cleanups.push(() => created.shutdown('quit'))
      created.session.setActiveToolsByName([...created.session.getActiveToolNames(), 'codemode'])
      created.session.settingsManager.setCompactionEnabled(false)
      createReusableBuddySession({ session: created.session, shutdown: created.shutdown, assertModelAccess: async () => model, runContext: { current: null }, inputReferences: { pending: null }, materializeInput: async input => input.prompt })
      return created
    },
    async turn(created: Awaited<ReturnType<typeof createIsolatedBuddySession>>, call?: typeof nextCall) {
      nextCall = call
      await created.session.prompt('Perform the requested operation using the supplied history.')
      const result = created.session.messages.findLast(message => message.role === 'toolResult')
      if (result)
        expect(JSON.stringify(result)).not.toContain('"isError":true')
    },
  }
}

function images(context: Context) {
  return context.messages.flatMap(message => message.role === 'toolResult' ? message.content.filter(block => block.type === 'image') : [])
}

function response(model: Model<Api>, call: Pick<ToolCall, 'name' | 'arguments'> | undefined, callId: number) {
  const message: AssistantMessage = {
    api: model.api,
    provider: model.provider,
    model: model.id,
    role: 'assistant',
    timestamp: Date.now(),
    content: call ? [{ type: 'toolCall', id: `call-${callId}`, ...call }] : [{ type: 'text', text: 'Done' }],
    stopReason: call ? 'toolUse' : 'stop',
    usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
  const stream = createAssistantMessageEventStream()
  queueMicrotask(() => stream.push({ type: 'done', reason: call ? 'toolUse' : 'stop', message }))
  return stream
}
