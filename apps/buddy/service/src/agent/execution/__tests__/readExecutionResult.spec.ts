import type { BuddyRunEvent } from '../../../events/BuddyRunEvent'
import { describe, expect, it } from 'vitest'
import { readExecutionResult } from '../readExecutionResult'

function read(payloads: unknown[]) {
  const events: BuddyRunEvent[] = payloads.map((payload, index) => ({ runId: 'child', sequence: index + 1, createdAt: '2026-10-12T00:00:00.000Z', type: 'message.completed', payload }))
  return readExecutionResult({ read: async () => events }, 'child')
}

describe('completed execution report', () => {
  it('retains full findings when a later continuation only adds a correction', async () => {
    const report = await read([
      { role: 'assistant', content: { text: 'Inspecting files' }, phase: 'commentary' },
      { role: 'assistant', content: { text: 'Finding A\nFinding B\nFinding C' }, phase: 'final_answer', stopReason: 'completed' },
      { role: 'assistant', content: { text: 'Finding A corrected; the other two findings remain' }, phase: 'final_answer', stopReason: 'completed' },
      { role: 'assistant', content: '', stopReason: 'completed' },
      { role: 'assistant', content: 'Failed partial response', stopReason: 'failed' },
    ])
    expect(report.startsWith('Finding A corrected')).toBe(true)
    expect(report).toContain('Finding B\nFinding C')
    expect(report).not.toContain('Inspecting files')
    expect(report).not.toContain('Failed partial response')
  })

  it('supports historical text and keeps the latest repeated report current', async () => {
    expect(await read([{ role: 'assistant', content: 'Report A' }])).toBe('Report A')
    const result = await read(['Report A', 'Report B', 'Report A'].map(content => ({ role: 'assistant', content })))
    expect(result.startsWith('Report A')).toBe(true)
    expect(result.match(/Report A/g)).toHaveLength(1)
    expect(result).toContain('Report B')
    expect(await read([{ role: 'user', content: 'Private input' }])).toBe('')
  })
})
