import type { InputModel } from '../../../providers/modelCapabilities'
import { describe, expect, it } from 'vitest'
import { createBuddyInputReference } from '../BuddyInputReference'
import { projectBuddyInput, projectMessageImages } from '../projectBuddyInput'

const model: InputModel = {
  api: 'openai-completions',
  baseUrl: 'https://api.xiaomimimo.com/v1',
  provider: 'fixture',
  id: 'mimo-v2.5',
  name: 'Fixture',
  input: ['text', 'image'],
  audioInput: true,
  contextWindow: 128_000,
  maxTokens: 8192,
  reasoning: false,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

describe('request attachment projection', () => {
  const input = createBuddyInputReference({
    messageId: 'message',
    prompt: 'Understand and convert these files',
    attachmentIds: ['image', 'audio', 'video'],
    images: [{ attachmentId: 'image', mimeType: 'image/png' }],
    documents: [{ attachmentId: 'audio', mimeType: 'audio/mp4' }, { attachmentId: 'video', mimeType: 'video/webm' }],
  })
  const sizes = new Map([['image', 1_000], ['audio', 1_000], ['video', 1_000]])

  it('keeps MiMo native audio alongside a tool-only video and preserves the original reference', () => {
    const before = structuredClone(input)
    const projected = projectBuddyInput(input, model, sizes).input
    expect(projected.images).toEqual(input.images)
    expect(projected.documents).toEqual([input.documents![0]])
    expect(projected.attachmentIds).toEqual(input.attachmentIds)
    const textOnly = projectBuddyInput(input, { ...model, input: ['text'], audioInput: false }, sizes).input
    expect(textOnly.images).toEqual([])
    expect(textOnly.documents).toEqual([])
    expect(textOnly.attachmentIds).toEqual(input.attachmentIds)
    expect(projectBuddyInput(input, model, sizes).input).toEqual(projected)
    expect(input).toEqual(before)
  })

  it('retains a file when its native content does not fit and restores it with sufficient budget', () => {
    const small = projectBuddyInput(input, model, sizes, 2_000)
    expect(small.input.images).toHaveLength(1)
    expect(small.input.documents).toEqual([])
    expect(small.input.attachmentIds).toEqual(input.attachmentIds)
    expect(small.bytes).toBeLessThanOrEqual(2_000)
    expect(projectBuddyInput(input, model, sizes, 4_000).input.documents).toHaveLength(1)
  })

  it('does not let an override enable a native representation absent from the endpoint', () => {
    expect(projectBuddyInput(input, { ...model, baseUrl: 'https://example.test/v1', videoInput: true }, sizes).input.documents).toEqual([])
  })

  it('projects previous image tool results when switching models without editing history', () => {
    const tool = { role: 'toolResult' as const, toolCallId: 'call', toolName: 'read', isError: false, timestamp: 0, content: [{ type: 'text' as const, text: 'Working file: /workspace/image.png' }, { type: 'image' as const, mimeType: 'image/png', data: 'image-bytes' }] }
    const projected = projectMessageImages(tool, { ...model, input: ['text'] })
    expect(projected).toMatchObject({ content: [{ type: 'text', text: 'Working file: /workspace/image.png' }, { type: 'text', text: expect.stringContaining('not supplied') }] })
    expect(projectMessageImages(tool, model)).toBe(tool)
    expect(tool.content[1]).toMatchObject({ type: 'image', data: 'image-bytes' })
  })

  it('shares an image budget between attachment references and tool results without modifying either', () => {
    const limited = { ...model, inputLimits: { images: { maxPerMessage: 1, maxPerRequest: 1 } } }
    const twoImages = { ...input, images: [...input.images, { attachmentId: 'other', mimeType: 'image/png' }] }
    const projected = projectBuddyInput(twoImages, limited, new Map([...sizes, ['other', 1000]]), 10_000, 1)
    expect(projected.input.images).toEqual(input.images)
    const tool = { role: 'toolResult' as const, toolCallId: 'call', toolName: 'read', isError: false, timestamp: 0, content: [{ type: 'image' as const, mimeType: 'image/png', data: 'AAAA' }] }
    const budget = { remainingBytes: 10_000 - projected.bytes, remainingImages: 0, remainingMessageImages: 1 }
    expect(projectMessageImages(tool, limited, budget)).toMatchObject({ content: [{ type: 'text', text: expect.stringContaining('not supplied') }] })
    expect(twoImages.images).toHaveLength(2)
    expect(tool.content[0]?.data).toBe('AAAA')
  })
})
