import { describe, expect, it } from 'vitest'
import { formatSessionReferenceClipboard, parseSessionReferenceClipboard } from '../sessionReferenceClipboard'

describe('session reference clipboard protocol', () => {
  it('round-trips multiple references while leaving surrounding user text intact', () => {
    const value = `Please compare these.\n${formatSessionReferenceClipboard({ id: 'session-a', title: 'First session' })}\n${formatSessionReferenceClipboard({ id: 'session-b', title: 'Second session' })}`
    expect(parseSessionReferenceClipboard(value)).toEqual({
      references: [
        { id: 'session-a', title: 'First session' },
        { id: 'session-b', title: 'Second session' },
      ],
      text: 'Please compare these.',
    })
  })

  it('treats malformed protocol text as ordinary clipboard content', () => {
    const value = 'LEXORA_SESSION_REF_V1:%broken'
    expect(parseSessionReferenceClipboard(value)).toBeNull()
  })

  it('does not interpret ordinary text as a session reference', () => {
    expect(parseSessionReferenceClipboard('Hello there')).toBeNull()
  })
})
