import { convertToLlm, SessionManager } from '@earendil-works/pi-coding-agent'
import { describe, expect, it } from 'vitest'
import { PUBLIC_CONTEXT_TYPE } from '../../../conversations/publicConversationContext'
import { prepareBuddyInputHistory } from '../prepareBuddyInputHistory'

const source = { sourceId: 'message:empty', sequence: 1, branchId: 'branch', runId: 'previous', sourceSequence: null, actorId: 'actor' }

describe('public material provider payload', () => {
  it('omits empty historical envelopes while retaining text, resource references and artifacts without rewriting history', () => {
    const manager = SessionManager.inMemory()
    const materials = [
      { ...source, kind: 'message', messageId: 'empty', role: 'assistant', text: '  ' },
      { ...source, sourceId: 'output:empty', kind: 'output', artifacts: [] },
      { ...source, sourceId: 'message:fact', kind: 'message', messageId: 'fact', role: 'assistant', text: 'A verified fact' },
      { ...source, sourceId: 'message:reference', kind: 'message', messageId: 'reference', role: 'user', text: '', references: [{ kind: 'resource', resourceId: 'image' }] },
      { ...source, sourceId: 'output:file', kind: 'output', artifacts: [{ artifactId: 'file', name: 'output.json', kind: 'file' }] },
    ]
    for (const material of materials) manager.appendCustomMessageEntry(PUBLIC_CONTEXT_TYPE, JSON.stringify(material), false, material)
    const before = JSON.stringify(manager.getEntries())
    const payload = convertToLlm(prepareBuddyInputHistory(manager.buildSessionContext().messages))
    expect(payload).toHaveLength(3)
    expect(JSON.stringify(payload)).toContain('A verified fact')
    expect(JSON.stringify(payload)).toContain('image')
    expect(JSON.stringify(payload)).toContain('output.json')
    expect(JSON.stringify(payload)).not.toContain('message:empty')
    expect(JSON.stringify(manager.getEntries())).toBe(before)
  })
})
