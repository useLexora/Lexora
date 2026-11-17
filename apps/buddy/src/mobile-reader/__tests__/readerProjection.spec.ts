import { describe, expect, it } from 'vitest'
import { ReaderProjection } from '../readerProjection'
import { readerActionSchema, readerUpdateSchema } from '../readerProtocol'

const update = (topic: string, extra: Record<string, unknown> = {}) => readerUpdateSchema.parse({ topic, reset: false, dark: false, fontScale: 1, entries: [], ...extra })
const event = (sequence: number) => ({ runId: 'run', sequence, type: 'run.started', createdAt: '2026-11-11T05:00:00Z', payload: {} })

describe('reader projection', () => {
  it('retains unchanged entries, removes old order entries and isolates topics', () => {
    const projection = new ReaderProjection()
    const a = { id: 'a', continuation: false, messages: [] }
    const b = { id: 'b', continuation: false, messages: [] }
    expect(projection.apply(update('one', { order: ['a', 'b'], entries: [a, b] })).entries).toEqual([a, b])
    expect(projection.apply(update('one', { order: ['b'] })).entries).toEqual([b])
    expect(projection.apply(update('two', { order: ['a'], entries: [a] })).entries).toEqual([a])
    expect(projection.apply(update('two', { reset: true })).entries).toEqual([])
  })
  it('binds an anchor request to its original topic and message until a new request arrives', () => {
    const projection = new ReaderProjection()
    const first = projection.apply(update('one', { anchorMessageId: 'old', anchorRequestId: 'search-1' })).anchor
    expect(first).toEqual({ topic: 'one', messageId: 'old', requestId: 'search-1' })
    expect(projection.apply(update('one', { anchorMessageId: 'changed', anchorRequestId: 'search-1' })).anchor).toBe(first)
    expect(projection.apply(update('one')).anchor).toBeNull()
    expect(projection.apply(update('two', { anchorMessageId: 'old', anchorRequestId: 'search-1' })).anchor).toBeNull()
    expect(projection.apply(update('two', { anchorMessageId: 'old', anchorRequestId: 'search-2' })).anchor).toEqual({ topic: 'two', messageId: 'old', requestId: 'search-2' })
  })
  it('keeps legacy updates valid and validates navigation without granting other capabilities', () => {
    expect(update('legacy').anchorMessageId).toBeUndefined()
    expect(readerUpdateSchema.safeParse({ ...update('one'), anchorRequestId: '' }).success).toBe(false)
    expect(readerUpdateSchema.safeParse({ ...update('one'), anchorMessageId: '' }).success).toBe(false)
    expect(readerActionSchema.parse({ action: 'latest', topic: 'one' })).toEqual({ action: 'latest', topic: 'one' })
    expect(readerActionSchema.safeParse({ action: 'latest', topic: 'one', url: 'https://example.invalid' }).success).toBe(false)
  })
  it('appends transcript deltas and replaces the stream on reset', () => {
    const projection = new ReaderProjection()
    projection.apply(update('one', { transcripts: { run: { events: [event(1)] } } }))
    const appended = projection.apply(update('one', { transcripts: { run: { events: [event(2)], append: true } } }))
    expect(appended.transcripts.run?.events.map(event => event.sequence)).toEqual([1, 2])
    expect(projection.apply(update('one', { reset: true, transcripts: { run: { events: [event(3)] } } })).transcripts.run?.events).toEqual([event(3)])
    expect(projection.apply(update('two')).transcripts).toEqual({})
  })
})
