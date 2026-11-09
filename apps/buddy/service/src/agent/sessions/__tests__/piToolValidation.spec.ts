import type { AssistantMessage, ToolCall } from '@earendil-works/pi-ai'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { BuddyExtensionRunContext } from '../../extensions/BuddyExtensionRunContext'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAssistantMessageEventStream, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolAuthorizationService } from '../../../permissions/ToolAuthorizationService'
import { createCodemodeCapability } from '../../extensions/codemodeExtension'
import { createToolPolicyExtension } from '../../extensions/toolPolicyExtension'
import { createIsolatedBuddySession } from './isolatedBuddySession'

const toolName = 'lexora_validation_fixture'
const typeboxSchema = Type.Object({
  count: Type.Number({ minimum: 1, maximum: 5 }),
  enabled: Type.Boolean(),
  labels: Type.Array(Type.String(), { minItems: 1 }),
  note: Type.Optional(Type.String()),
  nullableNote: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  nested: Type.Object({ value: Type.Integer() }),
})
const jsonSchema = {
  type: 'object',
  properties: {
    count: { type: 'number', minimum: 1, maximum: 5 },
    enabled: { type: 'boolean' },
    labels: { type: 'array', items: { type: 'string' }, minItems: 1 },
    note: { type: 'string' },
    nullableNote: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    nested: { type: 'object', properties: { value: { type: 'integer' } }, required: ['value'] },
  },
  required: ['count', 'enabled', 'labels', 'nested'],
}
const normalized = { count: 2.5, enabled: false, labels: ['alpha'], nullableNote: null, nested: { value: 3 } }
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
  vi.restoreAllMocks()
})

describe.each([
  { label: 'TypeBox', schema: typeboxSchema },
  { label: 'plain JSON Schema', schema: jsonSchema },
])('pi tool argument safety with $label', ({ schema }) => {
  it('normalizes before policy, approval and execution without rewriting assistant history', async () => {
    const fixture = await createFixture(schema)
    const input = modelArguments()
    const original = structuredClone(input)
    const call = await fixture.turn(input)

    expect(fixture.observations).toEqual(expectedObservations())
    expect(JSON.parse(await readFile(fixture.outputPath, 'utf8'))).toEqual(normalized)
    expect(fixture.lastResult()).toMatchObject({ isError: false })
    expect(fixture.lastResultText()).toBe(JSON.stringify(normalized))
    expect(input).toEqual(original)
    const messages = fixture.session.messages.filter(message => message.role === 'assistant')
    expect(messages.flatMap(message => message.content).filter(block => block.type === 'toolCall')).toEqual([call])
    const journalCalls = fixture.session.sessionManager.getEntries().flatMap(entry => entry.type === 'message' && entry.message.role === 'assistant'
      ? entry.message.content.filter(block => block.type === 'toolCall')
      : [])
    expect(journalCalls).toEqual([call])
    expect(call.arguments).toEqual(original)
  })

  it('rejects missing required fields, invalid booleans and numeric constraints before approval or writes', async () => {
    const fixture = await createFixture(schema)
    const { count: _count, ...missingCount } = modelArguments()
    for (const input of [missingCount, { ...modelArguments(), enabled: 'not-a-boolean' }, { ...modelArguments(), count: '9' }]) {
      await fixture.turn(input)
      expect(fixture.lastResult()).toMatchObject({ isError: true })
      expect(fixture.lastResultText()).toContain('Validation failed')
      expect(fixture.observations).toEqual([])
      expect(await readFile(fixture.outputPath, 'utf8')).toBe('unchanged')
    }
  })

  it('uses the same normalized approval and execution inputs for CodeMode nested calls', async () => {
    const fixture = await createFixture(schema)
    const input = modelArguments()
    const call = await fixture.turn(input, 'codemode')

    expect(fixture.observations).toEqual(expectedObservations())
    expect(JSON.parse(await readFile(fixture.outputPath, 'utf8'))).toEqual(normalized)
    expect(fixture.lastResult()).toMatchObject({
      isError: false,
      nestedCalls: { complete: true, calls: [{ name: toolName, status: 'ok' }] },
    })
    expect(fixture.lastResultText()).toContain(JSON.stringify(normalized))
    expect(fixture.parents).toEqual([call.id])
    const journalCalls = fixture.session.sessionManager.getEntries().flatMap(entry => entry.type === 'message' && entry.message.role === 'assistant'
      ? entry.message.content.filter(block => block.type === 'toolCall')
      : [])
    expect(journalCalls).toEqual([call])
  })

  it('rejects invalid nested CodeMode arguments without reaching approval or side effects', async () => {
    const fixture = await createFixture(schema)
    const { count: _count, ...missingCount } = modelArguments()
    for (const input of [missingCount, { ...modelArguments(), count: '9' }]) {
      await fixture.turn(input, 'codemode')
      expect(fixture.lastResult()).toMatchObject({
        isError: true,
        nestedCalls: { complete: true, calls: [{ name: toolName, status: 'error' }] },
      })
      expect(fixture.lastResultText()).toContain('Validation failed')
      expect(fixture.observations).toEqual([])
      expect(await readFile(fixture.outputPath, 'utf8')).toBe('unchanged')
    }
  })
})

it.each(['direct', 'codemode'] as const)('keeps an approval denial effective after normalization in %s calls', async (route) => {
  const fixture = await createFixture(typeboxSchema, 'denied')
  await fixture.turn(modelArguments(), route)
  expect(fixture.observations).toEqual(expectedObservations().slice(0, 2))
  expect(fixture.lastResult()).toMatchObject({ isError: true })
  expect(fixture.lastResultText()).toContain('APPROVAL_DENIED')
  expect(await readFile(fixture.outputPath, 'utf8')).toBe('unchanged')
})

function modelArguments() {
  return { count: '2.5', enabled: 'false', labels: 'alpha', note: null, nullableNote: null, nested: { value: '3' } }
}

function expectedObservations() {
  return ['policy', 'approval', 'authorized', 'execute'].map(phase => ({ phase, input: normalized }))
}

async function createFixture(schema: ToolDefinition['parameters'], decision: 'approved_once' | 'denied' = 'approved_once') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'buddy-pi-validation-')))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const outputPath = join(root, 'effect.json')
  await writeFile(outputPath, 'unchanged')
  const observations: { phase: string, input: unknown }[] = []
  const parents: (string | undefined)[] = []
  const record = (phase: string, input: unknown) => observations.push({ phase, input: structuredClone(input) })
  const run: BuddyExtensionRunContext = {
    runId: 'validation-run',
    signal: new AbortController().signal,
    flushProjectedEvents: async () => {},
    onToolExecutionAuthorized: async (event) => {
      if (event.toolName === toolName)
        record('authorized', event.arguments)
    },
  }
  const authorization = new ToolAuthorizationService({
    approvalAvailable: true,
    approvalPolicy: 'manual',
    executionProfile: 'workspace_write',
    cwd: root,
    owner: { kind: 'conversation', id: 'validation-conversation' },
    getGrants: () => [{ canonicalRoot: root, root, grantId: 'validation-workspace', kind: 'workspace' }],
    approvalService: {
      async request(input) {
        record('approval', input.arguments)
        return { approvalId: 'validation-approval', decision }
      },
    },
  })
  const policy = createToolPolicyExtension({
    authorization,
    getRunContext: () => run,
    classifyTool(event) {
      if (event.toolName !== toolName)
        return { access: 'read', paths: [] }
      record('policy', event.input)
      parents.push(event.parentToolCallId)
      return { access: 'write', paths: [{ path: outputPath, mode: 'existing' }] }
    },
  })
  const codemode = createCodemodeCapability(() => 'on')
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
  const model = runtime.getModels().find(model => model.provider === 'anthropic')!
  await runtime.setRuntimeApiKey(model.provider, 'offline-fixture')
  let nextCall: ToolCall | undefined
  vi.spyOn(runtime, 'streamSimple').mockImplementation((target) => {
    const call = nextCall
    nextCall = undefined
    const message: AssistantMessage = {
      role: 'assistant',
      api: target.api,
      provider: target.provider,
      model: target.id,
      timestamp: Date.now(),
      content: call ? [call] : [{ type: 'text', text: 'Done' }],
      stopReason: call ? 'toolUse' : 'stop',
      usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } },
    }
    const stream = createAssistantMessageEventStream()
    queueMicrotask(() => stream.push({ type: 'done', reason: call ? 'toolUse' : 'stop', message }))
    return stream
  })
  const created = await createIsolatedBuddySession({
    agentDir: join(root, 'agent'),
    canonicalRoot: root,
    cwd: root,
    conversationsDirectory: join(root, 'conversations'),
    conversationId: 'validation-conversation',
    branchId: 'validation-branch',
    approvalPolicy: 'manual',
    executionProfile: 'workspace_write',
    model,
    modelRuntime: runtime,
    thinkingLevel: 'off',
    resources: { skillReadRoots: [], skillReferences: [], approvedSkills: [], context: { agentsFiles: [], diagnostics: [] }, directoryContext: '', revision: 'empty' },
    inProcessExtensions: [
      {
        name: 'lexora-validation-fixture',
        factory(pi) {
          pi.registerTool({
            name: toolName,
            label: 'Validation fixture',
            description: 'Write validated input to an isolated fixture file',
            parameters: schema,
            async execute(_id, args) {
              record('execute', args)
              const text = JSON.stringify(args)
              await writeFile(outputPath, text)
              const mutable = args as typeof normalized
              mutable.nested.value = 99
              mutable.labels.push('executor-only')
              return { content: [{ type: 'text', text }], details: {} }
            },
          })
        },
      },
      policy,
      codemode.extension,
    ],
  })
  cleanups.push(async () => {
    await created.shutdown('quit')
    await codemode.dispose?.()
  })
  const { session } = created
  session.setActiveToolsByName([...session.getActiveToolNames(), 'codemode'])
  session.settingsManager.setCompactionEnabled(false)
  let turn = 0
  const lastResult = () => session.messages.filter(message => message.role === 'toolResult').at(-1)
  return {
    session,
    observations,
    parents,
    outputPath,
    lastResult,
    lastResultText: () => lastResult()?.content.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? '',
    async turn(input: ToolCall['arguments'], route: 'direct' | 'codemode' = 'direct') {
      const call: ToolCall = {
        type: 'toolCall',
        id: `validation-call-${++turn}`,
        name: route === 'codemode' ? 'codemode' : toolName,
        arguments: route === 'codemode'
          ? { code: `text(await tools.${toolName}(${JSON.stringify(input)}));` }
          : input,
      }
      const original = structuredClone(call)
      nextCall = call
      await session.prompt('Execute the validation fixture')
      return original
    },
  }
}
