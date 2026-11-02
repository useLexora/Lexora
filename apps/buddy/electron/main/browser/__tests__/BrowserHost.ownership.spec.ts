import { describe, expect, it } from 'vitest'
import { browserAgentTabId } from '../../../../shared/browser'
import { configureSemanticObservation, createFixture } from './browserHostFixture'

const ownerA = { runId: 'run-a', buddyId: 'actor-a' }
const ownerB = { runId: 'run-b', buddyId: 'actor-b' }

describe('browser execution ownership', () => {
  it('keeps concurrent runs and the human page separate, with lookup-only presentation', async () => {
    const { host } = createFixture()
    const human = host.ensureSession('task')
    const a = host.ensureAgentSession('task', ownerA)
    const b = host.ensureAgentSession('task', ownerB)
    expect(new Set([human.sessionId, a.sessionId, b.sessionId]).size).toBe(3)
    expect(host.ensureAgentSession('task', ownerA)).toEqual(a)
    expect(host.ensureSession('task', browserAgentTabId(ownerA.runId))).toEqual(a)
    expect(host.getGuestDescriptor(a.sessionId)).toMatchObject({ conversationId: 'task', owner: ownerA })
    expect(() => host.ensureAgentSession('task', { ...ownerA, buddyId: ownerB.buddyId })).toThrow('another execution')
    host.close(a.sessionId)
    expect(() => host.ensureSession('task', browserAgentTabId(ownerA.runId))).toThrow('unavailable')
    expect(host.getState(b.sessionId).pageId).toBe(b.pageId)
    expect(host.getState(human.sessionId).pageId).toBe(human.pageId)
    host.dispose()
    await host.whenIdle()
  })

  it('rejects another execution and missing ownership before reads, input, or lease changes', async () => {
    const fixture = createFixture()
    const { host } = fixture
    const a = host.ensureAgentSession('task', ownerA)
    configureSemanticObservation(fixture.webContents)
    await host.navigate(a.sessionId, 'https://example.com/app')
    const target = { sessionId: a.sessionId, pageId: a.pageId }
    const observation = await host.observe({ ...target, owner: ownerA })
    const lease = host.acquireControl({ ...target, owner: ownerA })
    for (const owner of [ownerB, undefined]) {
      await expect(host.observe({ ...target, owner })).rejects.toMatchObject({ code: 'BROWSER_CONTROL_REQUIRED' })
      await expect(host.read({ ...target, owner })).rejects.toMatchObject({ code: 'BROWSER_CONTROL_REQUIRED' })
      expect(() => host.acquireControl({ ...target, owner })).toThrow('another execution')
      expect(() => host.releaseControl({ ...target, owner, controlEpoch: lease.controlEpoch })).toThrow('another execution')
      await expect(host.act({ ...target, owner, action: { kind: 'click', ref: 'e1' }, frameId: 'main-frame', documentRevision: observation.documentRevision, observationId: observation.observationId, controlEpoch: lease.controlEpoch })).rejects.toMatchObject({ code: 'BROWSER_CONTROL_REQUIRED' })
    }
    expect(host.getState(a.sessionId)).toMatchObject({ controller: 'agent', controlEpoch: lease.controlEpoch })
    expect(() => host.acquireControl({ ...target, owner: ownerA })).toThrow('active controller')
    host.takeControl(a.sessionId)
    expect(() => host.releaseControl({ ...target, owner: ownerA, controlEpoch: lease.controlEpoch })).toThrow('control is required')
    host.dispose()
    await host.whenIdle()
  })

  it('cancels only the owning execution and retains idle pages for human inspection', async () => {
    const { host, webContentsInstances } = createFixture()
    const a = host.ensureAgentSession('task', ownerA)
    const b = host.ensureAgentSession('task', ownerB)
    host.acquireControl({ ...a, owner: ownerA })
    host.acquireControl({ ...b, owner: ownerB })
    await host.cancelExecution('task', ownerA)
    expect(host.getState(a.sessionId).controller).toBe('human')
    expect(host.getState(b.sessionId).controller).toBe('agent')
    expect(webContentsInstances.every(page => !page.isDestroyed())).toBe(true)
    expect(() => host.ensureAgentSession('task', ownerA)).toThrow('cancelled')
    expect(() => host.acquireControl({ ...a, owner: ownerA })).toThrow('cancelled')
    expect(host.ensureSession('task', browserAgentTabId(ownerA.runId)).sessionId).toBe(a.sessionId)
    host.dispose()
    await host.whenIdle()
  })
})
