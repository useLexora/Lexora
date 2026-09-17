import { deferred as createDeferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'
import { BrowserOperationGuard } from '../BrowserOperationGuard'
import { configureSemanticObservation, configureSensitiveSemanticObservation, createFixture } from './browserHostFixture'

describe('browserHost control and semantic actions', () => {
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
    const escapeInput = {
      alt: false,
      code: 'Escape',
      control: false,
      isAutoRepeat: false,
      isComposing: false,
      key: 'Escape',
      location: 0,
      meta: false,
      modifiers: [],
      shift: false,
      type: 'keyDown',
    }

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
          fixture.webContents.emit('did-start-loading')
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

  it('invalidates an approved action binding when the page changes before execution', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    configureSemanticObservation(fixture.webContents)
    await fixture.host.navigate(session.sessionId, 'https://example.com/app')
    const observation = await fixture.host.observe({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })
    const input = {
      action: { kind: 'click', ref: 'e1' } as const,
      documentRevision: observation.documentRevision,
      frameId: 'main-frame',
      observationId: observation.observationId,
      pageId: session.pageId,
      sessionId: session.sessionId,
    }
    fixture.webContents.debugger.sendCommand.mockClear()

    expect(fixture.host.validateAction(input)).toBeUndefined()
    expect(fixture.webContents.debugger.sendCommand).not.toHaveBeenCalled()

    fixture.webContents.emit(
      'did-navigate-in-page',
      {},
      'https://example.com/app/changed',
      true,
      1,
      1,
    )

    expect(() => fixture.host.validateAction(input)).toThrowError(expect.objectContaining({
      code: 'BROWSER_TARGET_STALE',
    }))
    expect(fixture.webContents.debugger.sendCommand).not.toHaveBeenCalled()
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

    await expect(firstAction).resolves.toMatchObject({ actionKind: 'click' })
    await queuedFailure
    expect(fixture.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ type: 'mousePressed' }),
    )
    expect(fixture.webContents.debugger.sendCommand.mock.calls.filter(([method, params]) => (
      method === 'Input.dispatchMouseEvent' && params?.type === 'mousePressed'
    ))).toHaveLength(1)
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

  it('advances document revision for SPA and child-frame navigation without replacing the main URL', async () => {
    const fixture = createFixture()
    const session = fixture.host.ensureSession('conversation-1')
    configureSemanticObservation(fixture.webContents)
    await fixture.host.navigate(session.sessionId, 'https://example.com/app')

    await expect(fixture.host.observe({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })).resolves.toMatchObject({ documentRevision: 1 })

    fixture.webContents.emit(
      'did-navigate-in-page',
      {},
      'https://example.com/app/reports#revenue',
      true,
      1,
      1,
    )

    await expect(fixture.host.observe({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })).resolves.toMatchObject({
      documentRevision: 2,
      url: 'https://example.com/app/reports',
    })

    fixture.webContents.emit(
      'did-frame-navigate',
      {},
      'https://widgets.example.test/chart',
      200,
      'OK',
      false,
      2,
      3,
    )
    fixture.webContents.emit(
      'did-navigate-in-page',
      {},
      'https://widgets.example.test/chart#quarter-2',
      false,
      2,
      3,
    )

    await expect(fixture.host.observe({
      pageId: session.pageId,
      sessionId: session.sessionId,
    })).resolves.toMatchObject({ documentRevision: 4 })
    expect(fixture.host.getState(session.sessionId).url).toBe(
      'https://example.com/app/reports#revenue',
    )
  })
})
