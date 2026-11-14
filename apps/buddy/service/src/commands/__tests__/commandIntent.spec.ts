import { describe, expect, it } from 'vitest'
import { canonicalCommandJson, fingerprintCommandIntent } from '../commandIntent'

describe('command intent version 1', () => {
  it('pins canonical bytes and SHA-256 independently of insertion order or locale', () => {
    expect(canonicalCommandJson({ z: 'é', a: [1, null, false], 中: '\n', Z: -0 })).toBe('{"Z":0,"a":[1,null,false],"z":"é","中":"\\n"}')
    const first = fingerprintCommandIntent('chat.startTurn', { draftId: 'draft-1', expectedRevision: 2 })
    expect(first).toMatchObject({ version: 1, fingerprint: 'a8f8296a77c88b66b8c6a847360d064bee539994f6d94c4793808483dab7acaf' })
    expect(fingerprintCommandIntent('chat.startTurn', { expectedRevision: 2, draftId: 'draft-1' })).toEqual(first)
    expect(canonicalCommandJson({ é: 'é', e: 'e\u0301' })).toBe('{"e":"é","é":"é"}')
    expect(canonicalCommandJson(['a', 'b'])).not.toBe(canonicalCommandJson(['b', 'a']))
  })

  it.each([Number.NaN, Number.MAX_SAFE_INTEGER + 1, { a: undefined }])('rejects non-JSON or inexact input case %#', (value) => {
    expect(() => canonicalCommandJson(value)).toThrow(TypeError)
  })

  it('whitelists business fields and preserves routing intent without adding envelope identity', () => {
    const intent = { draftId: 'draft-1', expectedRevision: 2 }
    for (const field of ['actorId', 'commandId', 'requestId', 'fingerprint', 'expectedServiceInstanceId', 'dataGeneration'])
      expect(() => fingerprintCommandIntent('chat.startTurn', { ...intent, [field]: 'injected' })).toThrow()
    const original = fingerprintCommandIntent('chat.startTurn', intent).fingerprint
    expect(fingerprintCommandIntent('chat.startTurn', { ...intent, expectedRevision: 3 }).fingerprint).not.toBe(original)
    expect(fingerprintCommandIntent('chat.startTurn', { ...intent, buddyId: 'buddy' }).fingerprint).not.toBe(original)
    const delivery = { mode: 'current', actorId: 'conversation-actor', target: { rootRunId: 'root', runId: 'execution' } } as const
    const route = fingerprintCommandIntent('chat.queue.enqueue', { ...intent, delivery }).fingerprint
    expect(fingerprintCommandIntent('chat.queue.enqueue', { ...intent, delivery: { ...delivery, target: null } }).fingerprint).not.toBe(route)
    expect(() => fingerprintCommandIntent('chat.queue.enqueue', { ...intent, delivery: { ...delivery, other: true } })).toThrow()
  })
})
