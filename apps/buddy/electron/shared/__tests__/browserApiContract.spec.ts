import { describe, expect, it } from 'vitest'
import * as desktopApiSchemas from '../desktopApiSchemas'

const SESSION_ID = '6f828cc1-6549-4245-b26e-43b2917c9281'

describe('desktop browser API contract', () => {
  it('preserves independent browser preference patches without inserting defaults', () => {
    const schema = desktopApiSchemas.lexoraConfigPatchSchema
    expect(schema.parse({ browser: { defaultZoomFactor: 1.25 } }))
      .toEqual({ browser: { defaultZoomFactor: 1.25 } })
    expect(schema.parse({ browser: { screenshotDestination: 'clipboard' } }))
      .toEqual({ browser: { screenshotDestination: 'clipboard' } })
    for (const defaultZoomFactor of [0, -1, 3.1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(schema.safeParse({ browser: { defaultZoomFactor } }).success).toBe(false)
  })

  it('requires an independent tab identity for a browser without a conversation', () => {
    const schema = desktopApiSchemas.browserEnsureSessionInputSchema
    expect(schema.parse({ conversationId: null, tabId: 'manual-tab' }))
      .toEqual({ conversationId: null, tabId: 'manual-tab' })
    expect(schema.parse({ conversationId: 'conversation' })).toEqual({ conversationId: 'conversation' })
    for (const tabId of [undefined, '', ' ', 'default'])
      expect(schema.safeParse({ conversationId: null, tabId }).success).toBe(false)
  })

  it('accepts only explicit default and incognito profile switches', () => {
    const schemas = desktopApiSchemas as Record<string, ContractSchema>
    const schema = schemas.browserSetProfileModeInputSchema

    expect(schema?.safeParse({
      profileMode: 'default',
      sessionId: SESSION_ID,
    }).success).toBe(true)
    expect(schema?.safeParse({
      profileMode: 'incognito',
      sessionId: SESSION_ID,
    }).success).toBe(true)
    expect(schema?.safeParse({
      profileMode: 'personal',
      sessionId: SESSION_ID,
    }).success).toBe(false)
  })

  it('opens an artifact by opaque identity without accepting a file path or conversation id', () => {
    const schemas = desktopApiSchemas as Record<string, ContractSchema>
    const schema = schemas.browserOpenArtifactInputSchema

    expect(schema?.safeParse({
      artifactId: 'artifact-1',
      sessionId: SESSION_ID,
    }).success).toBe(true)
    expect(schema?.safeParse({
      artifactId: 'artifact-1',
      conversationId: 'conversation-2',
      sessionId: SESSION_ID,
    }).success).toBe(false)
    expect(schema?.safeParse({
      artifactId: 'artifact-1',
      path: '/tmp/untrusted.html',
      sessionId: SESSION_ID,
    }).success).toBe(false)
  })
})

interface ContractSchema {
  safeParse: (value: unknown) => { success: boolean }
}
