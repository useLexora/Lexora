import { describe, expect, it, vi } from 'vitest'
import { ContextPanelHost } from '../ContextPanelHost'

describe('context panel owner facts', () => {
  it('keeps the accepted visible state when recording fails and isolates observers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const records: unknown[] = []
    const host = new ContextPanelHost(async (record) => {
      records.push(record)
      throw new Error('fixture private transport error')
    })
    const changes: unknown[] = []
    host.onDidChange(() => {
      throw new Error('observer')
    })
    host.onDidChange(change => changes.push(change))
    const target = { kind: 'browser' as const, source: { conversationId: 'conversation', runId: 'run' } }
    const command = host.execute({ action: 'open', target }, 'harness')
    expect(host.getState()).toMatchObject({ open: true, revision: 1, target })
    target.source.runId = 'changed-after-acceptance'
    await expect(command).resolves.toMatchObject({ open: true, target: { source: { runId: 'run' } } })
    expect(records).toHaveLength(1)
    expect(changes).toMatchObject([{ kind: 'state', state: { open: true } }, { kind: 'record', status: 'failed', state: { open: true } }])
    expect(JSON.stringify(changes)).not.toContain('private transport')
    await host.dispose()
  })
})
