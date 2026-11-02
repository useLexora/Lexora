import { deferred as createDeferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'
import { BrowserOperationGuard } from '../BrowserOperationGuard'
import { BrowserSecurityPolicy } from '../BrowserSecurityPolicy'
import { configureSemanticObservation, configureSensitiveSemanticObservation, createFixture } from './browserHostFixture'

describe('browserHost control and semantic actions', () => {
  it('rejects late agent navigation after human takeover during authorization', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation')
    configureSemanticObservation(fixture.webContents)
    await fixture.host.navigate(session.sessionId, 'https://example.com/')
    const observation = await fixture.host.observe({ sessionId: session.sessionId, pageId: session.pageId })
    const lease = fixture.host.acquireControl({ sessionId: session.sessionId, pageId: session.pageId })
    const ready = createDeferred<void>()
    const pending = createDeferred<void>()
    const authorize = BrowserSecurityPolicy.prototype.authorizeNavigation
    const delayed = vi.spyOn(BrowserSecurityPolicy.prototype, 'authorizeNavigation').mockImplementation(async function (this: BrowserSecurityPolicy, url) {
      const result = await authorize.call(this, url)
      ready.resolve()
      await pending.promise
      return result
    })
    const action = fixture.host.act({ ...lease, action: { kind: 'navigate', url: 'https://example.com/late' }, documentRevision: observation.documentRevision, observationId: observation.observationId })
    const rejected = expect(action).rejects.toMatchObject({ code: 'BROWSER_CONTROL_REQUIRED' })
    await ready.promise
    fixture.host.takeControl(session.sessionId)
    pending.resolve()
    await rejected
    expect(fixture.webContents.loadURL.mock.calls.map(([url]) => url)).toEqual(['https://example.com/'])
    expect(fixture.host.getState(session.sessionId)).toMatchObject({ controller: 'human', status: 'ready', error: null, url: 'https://example.com/' })
    delayed.mockRestore()
    fixture.host.dispose()
    await fixture.host.whenIdle()
  })

  it('preserves confirmed dispatch when the following observation fails', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation')
    configureSemanticObservation(fixture.webContents)
    await fixture.host.navigate(session.sessionId, 'https://example.com/')
    const observation = await fixture.host.observe({ sessionId: session.sessionId, pageId: session.pageId })
    const lease = fixture.host.acquireControl({ sessionId: session.sessionId, pageId: session.pageId })
    const changes: Array<{ kind: string, phase?: string, effect?: string }> = []
    fixture.host.onDidChange(change => changes.push(change))
    vi.spyOn(fixture.host, 'observe').mockRejectedValueOnce(new Error('fixture observation failed'))
    await expect(fixture.host.act({ ...lease, action: { kind: 'click', ref: 'e1' }, frameId: 'main-frame', documentRevision: observation.documentRevision, observationId: observation.observationId })).rejects.toThrow('fixture observation failed')
    expect(changes.filter(change => change.kind === 'action')).toMatchObject([{ phase: 'dispatched', effect: 'unknown' }, { phase: 'confirmed', effect: 'confirmed' }, { phase: 'failed', effect: 'confirmed' }])
    fixture.host.dispose()
    await fixture.host.whenIdle()
  })
  it('invalidates an approved target when page zoom changes', async () => {
    const fixture = createFixture()
    const state = fixture.host.ensureSession('conversation')
    configureSemanticObservation(fixture.webContents)
    await fixture.host.navigate(state.sessionId, 'https://example.com/')
    const observation = await fixture.host.observe({ sessionId: state.sessionId, pageId: state.pageId })
    const reference = {
      action: { kind: 'click', ref: 'e1' } as const,
      sessionId: state.sessionId,
      pageId: state.pageId,
      frameId: 'main-frame',
      documentRevision: observation.documentRevision,
      observationId: observation.observationId,
    }
    expect(() => fixture.host.validateAction(reference)).not.toThrow()
    await fixture.host.setZoomFactor(state.sessionId, 1.5)
    expect(() => fixture.host.validateAction(reference)).toThrowError(expect.objectContaining({ code: 'BROWSER_TARGET_STALE' }))
    fixture.host.dispose()
  })

  it('keeps lifecycle reads available during maintenance and rejects page mutations', async () => {
    const operations = new BrowserOperationGuard()
    const { host } = createFixture({ operations })
    const state = host.ensureSession('clear-data-conversation')
    const input = { sessionId: state.sessionId, pageId: state.pageId }
    const clearing = createDeferred<void>()
    const operation = operations.runMaintenance(() => clearing.promise)
    expect(host.getState(state.sessionId).sessionId).toBe(state.sessionId)
    expect(host.listGuests()).toHaveLength(1)
    expect(() => host.acquireControl(input)).toThrow('maintenance')
    expect(() => host.ensureSession('another-conversation')).toThrow('maintenance')
    await expect(host.setZoomFactor(state.sessionId, 1.5)).rejects.toMatchObject({ code: 'BROWSER_IN_USE' })
    host.setSurface({ sessionId: state.sessionId, visible: true })
    clearing.resolve()
    await operation
    await expect(operations.runMaintenance(async () => {
      throw new Error('disk failure')
    })).rejects.toThrow('disk failure')
    expect(host.acquireControl(input).controller).toBe('agent')
    host.dispose()
  })

  it('leaves Escape with the page while treating it as human input', () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    fixture.host.setSurface({
      sessionId: session.sessionId,
      visible: true,
    })
    fixture.host.acquireControl({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    const event = { preventDefault: vi.fn() }
    const escapeInput = { key: 'Escape', type: 'keyDown' }

    fixture.webContents.emit('before-input-event', event, escapeInput)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(fixture.host.getState(session.sessionId).controller).toBe('human')
  })

  it('validates page and semantic target identity before dispatching an action', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    configureSemanticObservation(fixture.webContents)
    await fixture.host.navigate(session.sessionId, 'https://example.com/app')
    const observation = await fixture.host.observe({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    const lease = fixture.host.acquireControl({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    const action = {
      action: { kind: 'click', ref: 'e1' } as const,
      controlEpoch: lease.controlEpoch,
      documentRevision: observation.documentRevision,
      frameId: 'main-frame',
      observationId: observation.observationId,
      pageId: session.pageId,
      sessionId: session.sessionId,
    }
    fixture.webContents.debugger.sendCommand.mockClear()

    await expect(fixture.host.act({
      ...action,
      pageId: '10000000-0000-4000-8000-000000000001',
    })).rejects.toMatchObject({ code: 'BROWSER_TARGET_STALE' })
    await expect(fixture.host.act({
      ...action,
      frameId: 'other-frame',
    })).rejects.toMatchObject({ code: 'BROWSER_TARGET_STALE' })
    expect(fixture.webContents.debugger.sendCommand).not.toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.anything(),
    )

    await expect(fixture.host.act(action)).resolves.toMatchObject({
      actionKind: 'click',
      observation: {
        pageId: session.pageId,
        sessionId: session.sessionId,
      },
      state: {
        pageId: session.pageId,
        sessionId: session.sessionId,
        url: 'https://example.com/app',
      },
    })
    expect(fixture.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed' }),
    )
  })

  it('distinguishes optional open conditions from required action waits', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    configureSemanticObservation(fixture.webContents)
    await fixture.host.navigate(session.sessionId, 'https://example.com/app')
    await expect(fixture.host.waitFor(session.sessionId, {
      condition: 'text-visible',
      text: 'Open report',
      timeoutMs: 200,
    })).resolves.toMatchObject({ condition: 'text-visible', satisfied: true })
    await expect(fixture.host.waitFor(session.sessionId, {
      condition: 'text-visible',
      text: 'Missing content',
      timeoutMs: 1,
    })).resolves.toMatchObject({ condition: 'text-visible', satisfied: false })
    const observation = await fixture.host.observe({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    const lease = fixture.host.acquireControl({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })

    await expect(fixture.host.act({
      action: {
        condition: 'text-visible',
        kind: 'wait',
        text: 'Missing content',
        timeoutMs: 1,
      },
      controlEpoch: lease.controlEpoch,
      documentRevision: observation.documentRevision,
      observationId: observation.observationId,
      pageId: session.pageId,
      sessionId: session.sessionId,
    })).rejects.toMatchObject({
      code: 'BROWSER_PAGE_FAILED',
      message: 'Browser wait condition timed out',
    })
  })

  it('waits for navigation started by an action before returning its fresh observation', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    configureSemanticObservation(fixture.webContents)
    await fixture.host.navigate(session.sessionId, 'https://example.com/app')
    const observation = await fixture.host.observe({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    const lease = fixture.host.acquireControl({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    const respond = fixture.webContents.debugger.sendCommand.getMockImplementation()!
    const destination = 'https://example.com/report'
    fixture.webContents.debugger.sendCommand.mockImplementation(async (method, params) => {
      const result = await respond(method, params)
      if (method === 'Input.dispatchMouseEvent' && params?.type === 'mouseReleased') {
        setTimeout(() => {
          fixture.webContents.emit('did-start-navigation', {}, destination, false, true)
          fixture.webContents.currentUrl = destination
          fixture.webContents.emit('did-navigate', {}, destination)
          fixture.webContents.emit('did-stop-loading')
        }, 0)
      }
      return result
    })

    const result = await fixture.host.act({
      action: { kind: 'click', ref: 'e1' },
      controlEpoch: lease.controlEpoch,
      documentRevision: observation.documentRevision,
      frameId: 'main-frame',
      observationId: observation.observationId,
      pageId: session.pageId,
      sessionId: session.sessionId,
    })

    expect(result.observation).toMatchObject({
      status: 'ready',
      url: destination,
    })
    expect(result.state).toMatchObject({
      status: 'ready',
      url: destination,
    })
  })

  it('keeps Main-owned control epochs monotonic across acquire, release, and human takeover', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    configureSemanticObservation(fixture.webContents)
    await fixture.host.navigate(session.sessionId, 'https://example.com/app')
    const observation = await fixture.host.observe({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    const action = {
      action: { kind: 'click', ref: 'e1' } as const,
      documentRevision: observation.documentRevision,
      frameId: 'main-frame',
      observationId: observation.observationId,
      pageId: session.pageId,
      sessionId: session.sessionId,
    }

    await expect(fixture.host.act({
      ...action,
      controlEpoch: 0,
    })).rejects.toMatchObject({ code: 'BROWSER_CONTROL_REQUIRED' })
    expect(fixture.webContents.debugger.sendCommand).not.toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.anything(),
    )

    const firstLease = fixture.host.acquireControl({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    expect(firstLease).toEqual({
      controller: 'agent',
      controlEpoch: 1,
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    expect(fixture.host.getState(session.sessionId)).toMatchObject({
      controller: 'agent',
      controlEpoch: 1,
    })

    await expect(fixture.host.act({
      ...action,
      controlEpoch: 0,
    })).rejects.toMatchObject({ code: 'BROWSER_CONTROL_REQUIRED' })
    await expect(fixture.host.act({
      ...action,
      controlEpoch: firstLease.controlEpoch,
    })).resolves.toMatchObject({ actionKind: 'click' })

    expect(() => fixture.host.releaseControl({
      controlEpoch: 0,
      pageId: session.pageId,
      sessionId: session.sessionId,
    })).toThrowError(expect.objectContaining({ code: 'BROWSER_CONTROL_REQUIRED' }))
    expect(fixture.host.releaseControl({
      controlEpoch: firstLease.controlEpoch,
      pageId: session.pageId,
      sessionId: session.sessionId,
    })).toMatchObject({
      controller: 'human',
      controlEpoch: 2,
    })

    const secondLease = fixture.host.acquireControl({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    expect(secondLease.controlEpoch).toBe(3)
    expect(fixture.host.takeControl(session.sessionId)).toMatchObject({
      controller: 'human',
      controlEpoch: 4,
    })
    await expect(fixture.host.act({
      ...action,
      controlEpoch: secondLease.controlEpoch,
    })).rejects.toMatchObject({ code: 'BROWSER_CONTROL_REQUIRED' })
  })

  it('rejects a queued old-epoch action after human takeover before another input lands', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    configureSemanticObservation(fixture.webContents)
    await fixture.host.navigate(session.sessionId, 'https://example.com/app')
    const observation = await fixture.host.observe({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    const lease = fixture.host.acquireControl({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    const action = {
      action: { kind: 'click', ref: 'e1' } as const,
      controlEpoch: lease.controlEpoch,
      documentRevision: observation.documentRevision,
      frameId: 'main-frame',
      observationId: observation.observationId,
      pageId: session.pageId,
      sessionId: session.sessionId,
    }
    const actionStarted = createDeferred<void>()
    const continueAction = createDeferred<void>()
    const sendCommand = fixture.webContents.debugger.sendCommand.getMockImplementation()!
    let heldFirstAction = false
    fixture.webContents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (
        method === 'Input.dispatchMouseEvent'
        && params?.type === 'mouseMoved'
        && !heldFirstAction
      ) {
        heldFirstAction = true
        actionStarted.resolve()
        await continueAction.promise
      }
      return sendCommand(method, params)
    })

    const firstAction = fixture.host.act(action)
    const firstFailure = expect(firstAction).rejects.toMatchObject({ code: 'BROWSER_CONTROL_REQUIRED' })
    await actionStarted.promise
    const queuedAction = fixture.host.act(action)
    const queuedFailure = expect(queuedAction).rejects.toMatchObject({
      code: 'BROWSER_CONTROL_REQUIRED',
    })

    expect(fixture.host.takeControl(session.sessionId)).toMatchObject({
      controller: 'human',
      controlEpoch: 2,
    })
    continueAction.resolve()

    await firstFailure
    await queuedFailure
    expect(fixture.webContents.debugger.sendCommand.mock.calls.filter(([method, params]) => (
      method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed'
    ))).toHaveLength(0)
  })

  it('requires a fresh observation after explicit or in-page human takeover', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    fixture.host.setSurface({
      sessionId: session.sessionId,
      visible: true,
    })
    configureSemanticObservation(fixture.webContents)
    await fixture.host.navigate(session.sessionId, 'https://example.com/app')
    const firstObservation = await fixture.host.observe({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    const firstLease = fixture.host.acquireControl({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })

    expect(fixture.host.takeControl(session.sessionId)).toMatchObject({
      controller: 'human',
      controlEpoch: firstLease.controlEpoch + 1,
    })
    const secondLease = fixture.host.acquireControl({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    await expect(fixture.host.act({
      action: { condition: 'page-ready', kind: 'wait', timeoutMs: 100 },
      controlEpoch: secondLease.controlEpoch,
      documentRevision: firstObservation.documentRevision,
      observationId: firstObservation.observationId,
      pageId: session.pageId,
      sessionId: session.sessionId,
    })).rejects.toMatchObject({ code: 'BROWSER_TARGET_STALE' })

    const secondObservation = await fixture.host.observe({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    const sendCommand = fixture.webContents.debugger.sendCommand.getMockImplementation()!
    let emittedAgentInput = false
    fixture.webContents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Input.dispatchMouseEvent' && !emittedAgentInput) {
        emittedAgentInput = true
        fixture.webContents.emit('before-mouse-event', {}, {
          button: 'left',
          clickCount: 1,
          type: 'mouseDown',
          x: 40,
          y: 36,
        })
      }
      return sendCommand(method, params)
    })
    await expect(fixture.host.act({
      action: { kind: 'click', ref: 'e1' },
      controlEpoch: secondLease.controlEpoch,
      documentRevision: secondObservation.documentRevision,
      frameId: 'main-frame',
      observationId: secondObservation.observationId,
      pageId: session.pageId,
      sessionId: session.sessionId,
    })).resolves.toMatchObject({ actionKind: 'click' })
    expect(fixture.host.getState(session.sessionId)).toMatchObject({
      controller: 'agent',
      controlEpoch: secondLease.controlEpoch,
    })

    const thirdObservation = await fixture.host.observe({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    fixture.webContents.emit('before-mouse-event', {}, {
      button: 'left',
      clickCount: 1,
      type: 'mouseMove',
      x: 48,
      y: 40,
    })
    expect(fixture.host.getState(session.sessionId).controller).toBe('agent')
    fixture.webContents.emit('before-mouse-event', {}, {
      button: 'left',
      clickCount: 1,
      type: 'mouseDown',
      x: 48,
      y: 40,
    })
    expect(fixture.host.getState(session.sessionId)).toMatchObject({
      controller: 'human',
      controlEpoch: secondLease.controlEpoch + 1,
    })

    const thirdLease = fixture.host.acquireControl({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    await expect(fixture.host.act({
      action: { condition: 'page-ready', kind: 'wait', timeoutMs: 100 },
      controlEpoch: thirdLease.controlEpoch,
      documentRevision: thirdObservation.documentRevision,
      observationId: thirdObservation.observationId,
      pageId: session.pageId,
      sessionId: session.sessionId,
    })).rejects.toMatchObject({ code: 'BROWSER_TARGET_STALE' })
  })

  it('hands sensitive input back to the human before any page input is dispatched', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    configureSensitiveSemanticObservation(fixture.webContents)
    await fixture.host.navigate(session.sessionId, 'https://example.com/sign-in')
    const observation = await fixture.host.observe({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    const password = observation.elements.find(element => element.name === 'Password')!
    const lease = fixture.host.acquireControl({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    fixture.webContents.debugger.sendCommand.mockClear()

    await expect(fixture.host.act({
      action: { kind: 'fill', ref: password.ref, text: 'must-not-be-dispatched' },
      controlEpoch: lease.controlEpoch,
      documentRevision: observation.documentRevision,
      frameId: password.frameId,
      observationId: observation.observationId,
      pageId: session.pageId,
      sessionId: session.sessionId,
    })).rejects.toMatchObject({ code: 'BROWSER_HUMAN_INPUT_REQUIRED' })

    expect(fixture.webContents.debugger.sendCommand).not.toHaveBeenCalled()
    expect(fixture.host.getState(session.sessionId)).toMatchObject({
      controller: 'human',
      controlEpoch: lease.controlEpoch + 1,
    })
    const nextLease = fixture.host.acquireControl({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    await expect(fixture.host.act({
      action: { condition: 'page-ready', kind: 'wait', timeoutMs: 100 },
      controlEpoch: nextLease.controlEpoch,
      documentRevision: observation.documentRevision,
      observationId: observation.observationId,
      pageId: session.pageId,
      sessionId: session.sessionId,
    })).rejects.toMatchObject({ code: 'BROWSER_TARGET_STALE' })
  })

  it('invalidates approved targets for SPA and child-frame navigation without replacing the main URL', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    const target = { pageId: session.pageId, sessionId: session.sessionId }
    configureSemanticObservation(fixture.webContents)
    await fixture.host.navigate(session.sessionId, 'https://example.com/app')
    const observation = await fixture.host.observe(target)
    const action = { ...target, action: { kind: 'click', ref: 'e1' } as const, frameId: 'main-frame' }
    expect(() => fixture.host.validateAction({ ...observation, ...action })).not.toThrow()

    const mainUrl = 'https://example.com/app/reports#revenue'
    fixture.webContents.currentUrl = mainUrl
    fixture.webContents.emit('did-navigate-in-page', {}, mainUrl, true)
    expect(() => fixture.host.validateAction({ ...observation, ...action })).toThrowError(expect.objectContaining({
      code: 'BROWSER_TARGET_STALE',
    }))
    const afterSpa = await fixture.host.observe(target)
    expect(afterSpa.url).toBe('https://example.com/app/reports')

    fixture.webContents.emit(
      'did-frame-navigate',
      {},
      'https://widgets.example.test/chart',
      200,
      'OK',
      false,
    )
    expect(() => fixture.host.validateAction({ ...afterSpa, ...action })).toThrowError(expect.objectContaining({
      code: 'BROWSER_TARGET_STALE',
    }))
    const afterChildNavigation = await fixture.host.observe(target)
    fixture.webContents.emit('did-navigate-in-page', {}, 'https://widgets.example.test/chart#quarter-2', false)
    expect(() => fixture.host.validateAction({ ...afterChildNavigation, ...action })).toThrowError(expect.objectContaining({
      code: 'BROWSER_TARGET_STALE',
    }))
    expect(fixture.host.getState(session.sessionId).url).toBe(mainUrl)
    fixture.host.dispose()
    await fixture.host.whenIdle()
  })
})
