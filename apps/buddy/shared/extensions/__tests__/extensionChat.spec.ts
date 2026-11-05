import { expect, it } from 'vitest'
import { extensionChatEventSchema, extensionChatRequestSchema } from '../extensionChat'
import { inferenceModelSchema } from '../extensionInference'

const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' } as const
const model = { id: 'vision', title: 'Vision fixture', capability: 'chat', contextWindow: 4096, maxTokens: 512, tools: false }
const request = { model: model.id, tools: [], maxTokens: 512 }

it('keeps text-only bindings compatible and validates declared chat input capabilities', () => {
  expect(inferenceModelSchema.parse(model)).toEqual(model)
  expect(inferenceModelSchema.parse({ ...model, input: ['text', 'image'] })).toEqual({ ...model, input: ['text', 'image'] })
  for (const input of [[], ['image'], ['text', 'text'], ['text', 'audio']])
    expect(inferenceModelSchema.safeParse({ ...model, input }).success).toBe(false)
})

it('accepts explicit automatic tool sources while retaining boolean bindings', () => {
  const source = { providerId: 'huggingface', modelId: 'Qwen/Qwen3.5-9B' }
  for (const tools of [true, false, 'auto'] as const) {
    const binding = { ...model, tools, catalogModels: [source] }
    expect(inferenceModelSchema.parse(binding)).toEqual(binding)
  }
  expect(inferenceModelSchema.parse({ ...model, tools: 'auto' }).tools).toBe('auto')
  for (const catalogModels of [[source, source], Array.from({ length: 9 }, (_, index) => ({ ...source, modelId: `model-${index}` })), [{ ...source, providerId: '' }], [{ ...source, modelId: '' }], [{ ...source, modelId: 'x'.repeat(257) }], [{ ...source, toolCall: true }]])
    expect(inferenceModelSchema.safeParse({ ...model, tools: 'auto', catalogModels }).success).toBe(false)
  expect(inferenceModelSchema.safeParse({ ...model, tools: 'true' }).success).toBe(false)
})

it('validates optional reasoning declarations and separate thinking events', () => {
  for (const reasoning of [true, false, 'auto'] as const)
    expect(inferenceModelSchema.parse({ ...model, reasoning }).reasoning).toBe(reasoning)
  expect(inferenceModelSchema.safeParse({ ...model, reasoning: 'high' }).success).toBe(false)
  expect(extensionChatEventSchema.parse({ type: 'thinking', text: 'Consider the result.' })).toEqual({ type: 'thinking', text: 'Consider the result.' })
  expect(extensionChatEventSchema.safeParse({ type: 'thinking', text: 'x'.repeat(16001) }).success).toBe(false)
})

it('preserves ordered user and tool image content without changing legacy message shapes', () => {
  const messages = [
    { role: 'system', text: 'Keep the image order.' },
    { role: 'user', text: 'A text-only turn.' },
    { role: 'user', content: [{ type: 'text', text: 'First' }, image, { type: 'text', text: 'Second' }, image] },
    { role: 'assistant', text: '', toolCalls: [{ id: 'call', name: 'read', arguments: { path: 'fixture.png' } }] },
    { role: 'tool', toolCallId: 'call', name: 'read', isError: false, content: [image, { type: 'text', text: 'Image result' }] },
    { role: 'tool', toolCallId: 'failed', name: 'read', isError: true, text: 'Not found' },
  ]
  expect(extensionChatRequestSchema.parse({ ...request, messages })).toEqual({ ...request, messages })
})

it.each([
  { role: 'user', text: 'ambiguous', content: [image] },
  { role: 'user', content: [] },
  { role: 'user', content: [{ ...image, url: 'https://example.test/image.png' }] },
  { role: 'user', content: [{ ...image, data: '/home/user/picture.png' }] },
  { role: 'user', content: [{ ...image, data: 'data:image/png;base64,iVBORw0KGgo=' }] },
  { role: 'user', content: [{ ...image, data: 'YQ=' }] },
  { role: 'user', content: [{ ...image, mimeType: 'image/svg+xml' }] },
  { role: 'assistant', content: [image], toolCalls: [] },
  { role: 'tool', content: [image], name: 'read', isError: false },
])('rejects unsupported or ambiguous image message structure %#', (message) => {
  expect(extensionChatRequestSchema.safeParse({ ...request, messages: [message] }).success).toBe(false)
})
