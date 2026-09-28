import type { ExtensionViewSnapshot, ExtensionViewUpdate } from '@buddy-shared/extensions/extensionViewProjection'
import { describe, expect, it, vi } from 'vitest'
import { ExtensionViewState } from '../../../../../electron/main/extensions/runtime/ExtensionViewState'
import { ExtensionViewProjection } from '../ExtensionViewProjection'

function snapshot(page = 'tasks'): ExtensionViewSnapshot {
  return { workbench: { values: { page }, pages: [] }, environment: { language: 'en-US', colorScheme: 'light', colors: {} }, visible: false, mount: null, anchor: null, control: null }
}
const policy = { decoration: false, control: false, interaction: false }
function update(sequence: number, page: string, streamId = 'stream'): ExtensionViewUpdate {
  return { streamId, sequence, event: { type: 'workbench:context:changed', data: { context: { values: { page }, pages: [] } } } }
}

describe('extension view projection and synchronization', () => {
  it('filters before advancing the scoped sequence and owns all snapshots and message payloads', () => {
    const initial = snapshot()
    const source = new ExtensionViewProjection(initial, policy)
    const other = new ExtensionViewProjection(initial, policy)
    source.publish({ type: 'composer:input:received', data: { caret: null } })
    source.publish({ type: 'view:anchor:changed', data: { anchor: { kind: 'composer.input', visible: true, width: 1, height: 1 } } })
    source.publish({ type: 'interaction:activated', data: { regionId: 'private', x: 1, y: 1 } })
    expect(source.synchronization.sequence).toBe(0)
    const events: ExtensionViewUpdate[] = []
    source.onDidChange(event => events.push(event))
    const message = { value: { count: 1 } }
    source.publish({ type: 'view:message:received', data: { message } })
    message.value.count = 2
    expect(events).toMatchObject([{ sequence: 1, event: { data: { message: { value: { count: 1 } } } } }])
    expect(other.synchronization.sequence).toBe(0)
    expect(Object.isFrozen(initial)).toBe(false)
    expect(Object.isFrozen(source.synchronization.snapshot.workbench.values)).toBe(true)
    source.dispose()
    source.publish({ type: 'view:visibility:changed', data: { visible: true } })
    expect(source.synchronization.sequence).toBe(1)
  })

  it('accepts only increments newer than bootstrap and never replays an already-covered transient message', () => {
    const receiver = new ExtensionViewState()
    const observed: string[] = []
    receiver.events.on('**', event => observed.push(event.type))
    receiver.acceptUpdate({ streamId: 'stream', sequence: 1, event: { type: 'view:message:received', data: { message: 'before snapshot' } } })
    receiver.acceptUpdate(update(2, 'latest'))
    receiver.initialize(snapshot('initial'), false, { streamId: 'stream', sequence: 1 })
    expect(receiver.snapshot.workbench.values.page).toBe('latest')
    expect(observed).toEqual(['workbench:context:changed'])
    receiver.acceptUpdate(update(2, 'duplicate'))
    expect(receiver.snapshot.workbench.values.page).toBe('latest')
    receiver.dispose()
  })

  it('reconciles a gap from the source snapshot while retaining newer increments and legacy notifications', async () => {
    const pending = Promise.withResolvers<{ streamId: string, sequence: number, snapshot: ExtensionViewSnapshot }>()
    const receiver = new ExtensionViewState(() => pending.promise)
    receiver.initialize(snapshot('initial'), false, { streamId: 'stream', sequence: 0 })
    const pages: unknown[] = []
    receiver.events.on('workbench:context:changed', ({ data }) => pages.push(data.context.values.page))
    receiver.acceptUpdate(update(3, 'newer'))
    pending.resolve({ streamId: 'stream', sequence: 2, snapshot: snapshot('reconciled') })
    await vi.waitFor(() => expect(receiver.synchronizationStatus).toBe('current'))
    expect(receiver.snapshot.workbench.values.page).toBe('newer')
    expect(pages).toEqual(['reconciled', 'newer'])
    receiver.dispose()
  })

  it('delivers received transient facts once after gap recovery without replaying old frames', async () => {
    const pending = Promise.withResolvers<{ streamId: string, sequence: number, snapshot: ExtensionViewSnapshot }>()
    const receiver = new ExtensionViewState(() => pending.promise)
    receiver.initialize(snapshot('initial'), true, { streamId: 'stream', sequence: 0 }, true)
    const received: string[] = []
    receiver.events.on('**', event => received.push(event.type))
    receiver.acceptUpdate({ streamId: 'stream', sequence: 2, event: { type: 'view:message:received', data: { message: 'received' } } })
    receiver.acceptUpdate({ streamId: 'stream', sequence: 3, event: { type: 'interaction:activated', data: { regionId: 'button', x: 1, y: 1 } } })
    receiver.acceptUpdate({ streamId: 'stream', sequence: 4, event: { type: 'composer:input:received', data: {} } })
    receiver.acceptUpdate({ streamId: 'old-frame', sequence: 5, event: { type: 'view:message:received', data: { message: 'old' } } })
    pending.resolve({ streamId: 'stream', sequence: 4, snapshot: snapshot('current') })
    await vi.waitFor(() => expect(receiver.synchronizationStatus).toBe('current'))
    receiver.acceptUpdate({ streamId: 'stream', sequence: 2, event: { type: 'view:message:received', data: { message: 'duplicate' } } })
    expect(received).toEqual(['workbench:context:changed', 'view:message:received', 'interaction:activated', 'composer:input:received'])
    receiver.dispose()
  })

  it('starts a new bounded recovery when a newer source watermark arrives after degradation', async () => {
    let unavailable = true
    let reads = 0
    const receiver = new ExtensionViewState(async () => {
      reads++
      if (unavailable)
        throw new Error('unavailable')
      return { streamId: 'stream', sequence: 5, snapshot: snapshot('recovered') }
    })
    receiver.initialize(snapshot(), false, { streamId: 'stream', sequence: 0 })
    receiver.acceptUpdate(update(3, 'gap'))
    await vi.waitFor(() => expect(receiver.synchronizationStatus).toBe('degraded'))
    expect(reads).toBe(3)
    receiver.acceptUpdate(update(3, 'duplicate'))
    await Promise.resolve()
    expect(reads).toBe(3)
    unavailable = false
    receiver.acceptUpdate(update(5, 'new watermark'))
    await vi.waitFor(() => expect(receiver.synchronizationStatus).toBe('current'))
    expect(receiver.snapshot.workbench.values.page).toBe('recovered')
    expect(reads).toBe(4)
    receiver.dispose()
  })

  it('recovers buffer overflow with a bounded read retry and ignores late completions after disposal', async () => {
    let reads = 0
    const receiver = new ExtensionViewState(async () => {
      reads++
      return { streamId: 'stream', sequence: 100, snapshot: snapshot('current') }
    })
    for (let sequence = 1; sequence <= 100; sequence++) receiver.acceptUpdate(update(sequence, String(sequence)))
    receiver.initialize(snapshot('old'), false, { streamId: 'stream', sequence: 0 })
    await vi.waitFor(() => expect(receiver.snapshot.workbench.values.page).toBe('current'))
    expect(reads).toBe(1)
    receiver.dispose()
    const pending = Promise.withResolvers<{ streamId: string, sequence: number, snapshot: ExtensionViewSnapshot }>()
    const closed = new ExtensionViewState(() => pending.promise)
    closed.initialize(snapshot('retained'), false, { streamId: 'stream', sequence: 0 })
    closed.acceptUpdate(update(2, 'unobserved'))
    closed.dispose()
    pending.resolve({ streamId: 'stream', sequence: 2, snapshot: snapshot('late') })
    await Promise.resolve()
    await Promise.resolve()
    expect(closed.snapshot.workbench.values.page).toBe('retained')
    let attempts = 0
    const failed = new ExtensionViewState(async () => {
      attempts++
      throw new Error('fixture unavailable')
    })
    failed.initialize(snapshot(), false, { streamId: 'stream', sequence: 0 })
    failed.acceptUpdate(update(2, 'gap'))
    await vi.waitFor(() => expect(failed.synchronizationStatus).toBe('degraded'))
    expect(attempts).toBe(3)
    failed.dispose()
  })
})
