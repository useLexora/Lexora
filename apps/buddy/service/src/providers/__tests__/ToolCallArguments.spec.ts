import type { Api, AssistantMessageFrame, ToolCall } from '@earendil-works/pi-ai'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AssistantMessageFrameEncoder, InMemoryCredentialStore, normalizeContext, reduceAssistantMessageFrames, validateToolArguments } from '@earendil-works/pi-ai'
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { beforeAll, describe, expect, it } from 'vitest'
import { withProviderStream } from '../withProviderStream'

let runtime: ModelRuntime
const context = normalizeContext({ messages: [{ role: 'user', content: 'Use the tool', timestamp: 1 }] })
const tool = { name: 'write', description: 'Write a file', parameters: Type.Object({ path: Type.Optional(Type.String()), content: Type.Optional(Type.String()) }) }
const apis = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const

beforeAll(async () => {
  runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false })
  for (const api of apis) {
    runtime.registerProvider(api, {
      api,
      baseUrl: 'https://fixture.example.test/v1',
      models: [{ id: 'fixture', name: 'Fixture', reasoning: false, input: ['text'], contextWindow: 4096, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    })
    await runtime.setRuntimeApiKey(api, 'offline-fixture')
  }
})

describe.each(apis)('%s final tool arguments', (api) => {
  it('rejects truncated arguments through permissive schemas and replay', async () => {
    const json = '{"path":"unsafe.txt","content":"partial"'
    const { call, frames } = await stream(api, json)
    expect(call.arguments).toEqual({})
    expect(call.argumentsError).toContain('not a complete JSON object')
    expect(() => validateToolArguments(tool, call)).toThrow('not a complete JSON object')
    const replayed = reduceAssistantMessageFrames(frames)!.content.find(block => block.type === 'toolCall')!
    expect(replayed).toMatchObject({ arguments: {}, argumentsError: call.argumentsError })
    expect(() => validateToolArguments(tool, replayed)).toThrow('not a complete JSON object')
  })

  it('preserves complete JSON arguments', async () => {
    const { call } = await stream(api, '{"path":"safe.txt","content":"complete"}')
    expect(call.argumentsError).toBeUndefined()
    expect(validateToolArguments(tool, call)).toEqual({ path: 'safe.txt', content: 'complete' })
  })
})

it('projects invalid names and orphaned results safely without rewriting stored history', async () => {
  const api = 'openai-completions'
  const model = runtime.getModels(api)[0]!
  const longName = 'x'.repeat(129)
  const invalid = ['bad name', longName, '']
  const usage = { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, total: 0, cacheRead: 0, cacheWrite: 0 } }
  const history = normalizeContext({ messages: [
    { role: 'assistant', api, provider: api, model: model.id, timestamp: 1, stopReason: 'toolUse', usage, content: [
      ...invalid.map((name, index) => ({ type: 'toolCall' as const, id: `invalid-${index}`, name, arguments: {} })),
      { type: 'toolCall', id: 'valid', name: 'write', arguments: { content: 'valid arguments' } },
      { type: 'toolCall', id: 'orphan', name: 'write', arguments: { path: 'possibly-written.txt' } },
    ] },
    ...invalid.map((_name, index) => ({ role: 'toolResult' as const, toolCallId: `invalid-${index}`, toolName: 'invalid', content: [{ type: 'text' as const, text: 'invalid-result-marker' }], isError: true, timestamp: 2 })),
    { role: 'toolResult', toolCallId: 'valid', toolName: 'write', content: [{ type: 'text', text: 'valid-result-marker' }], isError: false, timestamp: 3 },
    { role: 'user', content: 'Continue', timestamp: 4 },
  ], tools: [tool] })
  const saved = structuredClone(history)
  let payload: unknown
  await runtime.getProvider(api)!.stream(model, history, {
    apiKey: 'offline-fixture',
    maxRetries: 0,
    onPayload: (value) => { payload = value },
    fetch: async () => new Response(body(api, '{}'), { headers: { 'content-type': 'text/event-stream' } }),
  }).result()
  const serialized = JSON.stringify(payload)
  expect(serialized).not.toContain(longName)
  expect(serialized).not.toContain('bad name')
  expect(serialized).not.toContain('invalid-result-marker')
  expect(serialized).toContain('valid-result-marker')
  expect(serialized).toContain('valid arguments')
  expect(serialized).toContain('its outcome is unknown')
  expect(serialized).toContain('verify the current state first')
  expect(history).toEqual(saved)
})

it('rejects duplicate tool IDs before any tool side effect', async () => {
  const api = 'openai-completions'
  const ids = ['same', 'same']
  const model = runtime.getModels(api)[0]!
  const provider = withProviderStream(runtime.getProvider(api)!)
  const writes: unknown[] = []
  const root = await mkdtemp(join(tmpdir(), 'buddy-tool-identity-'))
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } })
  const resourceLoader = new DefaultResourceLoader({
    cwd: root,
    agentDir: root,
    settingsManager,
    noExtensions: true,
    disabledBuiltinExtensions: ['mcp', 'codemode'],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  })
  await resourceLoader.reload()
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: root,
    model,
    modelRuntime: runtime,
    resourceLoader,
    sessionManager: SessionManager.inMemory(root),
    settingsManager,
    tools: ['write'],
    customTools: [{ ...tool, label: 'Write', execute: async (_id, args) => {
      writes.push(args)
      return { content: [{ type: 'text', text: 'written' }], details: null }
    } }],
  })
  let requests = 0
  session.agent.streamFunction = (model, context, options) => provider.stream(model, context, {
    ...options,
    apiKey: 'offline-fixture',
    maxRetries: 0,
    fetch: async () => {
      if (++requests > 1)
        throw new Error('Unexpected repeated model request')
      return new Response(body(api, '{"content":"must not be written"}', ids), { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  try {
    await session.prompt('Write a file')
    const reply = session.messages.find(message => message.role === 'assistant')!
    expect(reply).toMatchObject({ stopReason: 'error', errorMessage: expect.stringContaining('duplicate or empty tool call IDs') })
    expect(reply.content).toHaveLength(ids.length)
    expect(writes).toEqual([])
    expect(session.messages.some(message => message.role === 'toolResult')).toBe(false)
  }
  finally {
    session.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps an unfinished streaming preview non-executable when its progress frames are reconstructed', () => {
  const partial = {
    role: 'assistant' as const,
    api: 'openai-completions' as const,
    provider: 'fixture',
    model: 'fixture',
    content: [],
    stopReason: 'toolUse' as const,
    timestamp: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  }
  const frames: AssistantMessageFrame[] = [
    { type: 'start', partial },
    { type: 'toolcall_start', contentIndex: 0, toolCall: { type: 'toolCall', id: 'call', name: 'write', arguments: {} } },
    { type: 'toolcall_delta', contentIndex: 0, delta: '{"content":"unfinished' },
  ]
  const call = reduceAssistantMessageFrames(frames)!.content[0] as ToolCall
  expect(() => validateToolArguments(tool, call)).toThrow('not a complete JSON object')
})

async function stream(api: Api, json: string) {
  const model = runtime.getModels(api)[0]!
  const provider = runtime.getProvider(api)!
  const source = provider.stream(model, normalizeContext({ messages: context.messages, tools: [tool] }), {
    apiKey: 'offline-fixture',
    maxRetries: 0,
    fetch: async () => new Response(body(api, json), { headers: { 'content-type': 'text/event-stream' } }),
  })
  const encoder = new AssistantMessageFrameEncoder()
  const frames: AssistantMessageFrame[] = []
  for await (const event of source) {
    const frame = encoder.encode(event)
    if (frame)
      frames.push(frame)
  }
  const message = await source.result()
  expect(message.stopReason, message.errorMessage).toBe('toolUse')
  return { call: message.content.find(block => block.type === 'toolCall')!, frames }
}

function body(api: Api, json: string, ids = ['call']) {
  const frame = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`
  if (api === 'openai-completions') {
    return `${frame({ id: 'response', choices: [{ index: 0, delta: { tool_calls: ids.map((id, index) => ({ index, id, type: 'function', function: { name: 'write', arguments: json } })) }, finish_reason: null }] })
      + frame({ id: 'response', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    }data: [DONE]\n\n`
  }
  if (api === 'anthropic-messages') {
    const events = [
      { type: 'message_start', message: { id: 'response', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      ...ids.flatMap((id, index) => [
        { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name: 'write', input: {} } },
        { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json } },
        { type: 'content_block_stop', index },
      ]),
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    return events.map(event => frame(event, event.type)).join('')
  }
  const items = ids.map((id, index) => ({ type: 'function_call', id: `fc_${index}`, call_id: id, name: 'write', arguments: json, status: 'completed' }))
  return [
    { type: 'response.created', response: { id: 'response', status: 'in_progress', output: [] } },
    ...items.flatMap((item, index) => [
      { type: 'response.output_item.added', output_index: index, item: { ...item, arguments: '', status: 'in_progress' } },
      { type: 'response.function_call_arguments.delta', item_id: item.id, output_index: index, delta: json },
      { type: 'response.output_item.done', output_index: index, item },
    ]),
    { type: 'response.completed', response: { id: 'response', status: 'completed', output: items, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ].map(event => frame(event, event.type)).join('')
}
