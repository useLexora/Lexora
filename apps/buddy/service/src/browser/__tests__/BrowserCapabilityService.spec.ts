import type {
  BrowserObservation,
  BrowserStateSnapshot,
} from '../../../../shared/browser'
import type { DirectoryGrant } from '../../directories/resolveGrantedPath'
import type { BrowserCapabilityHost } from '../BrowserCapabilityService'
import { deferred as createDeferred } from '@buddy-tests/deferred'
import { describe, expect, it, vi } from 'vitest'
import { BrowserCapabilityService } from '../BrowserCapabilityService'

const SESSION_ID = '6f828cc1-6549-4245-b26e-43b2917c9281'
const OTHER_SESSION_ID = '06b0a789-94da-41bd-b9d0-e34a99e35ec8'
const PAGE_ID = 'ed312709-baf9-44b3-a292-108055838477'
const CURRENT_PAGE_ID = '9b230ce2-b3eb-4ae4-ac33-37c4c7b2339a'
const OBSERVATION_ID = 'b3a5d63b-17b7-4b5a-863a-37f135e297d4'
const POST_ACTION_OBSERVATION_ID = '2e7d9de1-fd2f-4f83-aef2-74a3b830dc48'

const READY_STATE: BrowserStateSnapshot = {
  canGoBack: false,
  canGoForward: false,
  controller: 'human',
  controlEpoch: 0,
  conversationId: 'conversation-1',
  error: null,
  pageId: PAGE_ID,
  profileMode: 'default',
  security: { kind: 'secure', origin: 'https://example.com' },
  sessionId: SESSION_ID,
  status: 'ready',
  title: 'Example',
  url: 'https://example.com/docs',
  visible: true,
}

const OBSERVATION: BrowserObservation = {
  documentRevision: 2,
  elements: [],
  observationId: OBSERVATION_ID,
  pageId: CURRENT_PAGE_ID,
  sessionId: SESSION_ID,
  status: 'ready',
  title: 'Current page',
  truncated: false,
  url: 'https://example.com/current',
}

const ACTION_INPUT = {
  action: { kind: 'click', ref: 'e1' } as const,
  documentRevision: 2,
  frameId: 'main-frame',
  observationId: OBSERVATION_ID,
  pageId: PAGE_ID,
}

describe('browserCapabilityService', () => {
  it('reads and copies the current Pi session grants for local files', async () => {
    const host = createHost()
    host.openLocal.mockResolvedValue({ ok: true, state: READY_STATE })
    const grants: DirectoryGrant[] = [{
      canonicalRoot: '/workspace/space',
      grantId: 'space-1',
      kind: 'workspace' as const,
      root: '/workspace/space-link',
    }]
    const service = createService(host, () => grants)
    grants.push({
      canonicalRoot: '/workspace/additional',
      grantId: 'space-directory-2',
      kind: 'workspace' as const,
      root: '/workspace/additional-link',
    })

    await service.open({
      entryPath: '/workspace/space/report.html',
      kind: 'local-file',
    })
    grants[1]!.canonicalRoot = '/other'

    expect(host.openLocal).toHaveBeenCalledExactlyOnceWith({
      conversationId: 'conversation-1',
      entryPath: '/workspace/space/report.html',
      grants: [
        {
          canonicalRoot: '/workspace/space',
          grantId: 'space-1',
          kind: 'workspace' as const,
          root: '/workspace/space-link',
        },
        {
          canonicalRoot: '/workspace/additional',
          grantId: 'space-directory-2',
          kind: 'workspace' as const,
          root: '/workspace/additional-link',
        },
      ],
    })
  })

  it('does not adopt a successful open state from another conversation', async () => {
    const host = createHost()
    host.openUrl.mockResolvedValue({
      ok: true,
      state: {
        ...READY_STATE,
        conversationId: 'conversation-2',
        sessionId: OTHER_SESSION_ID,
      },
    })
    const service = createService(host)

    await expect(service.open({
      kind: 'url',
      url: READY_STATE.url,
    })).resolves.toEqual(sessionNotFound())
    await expect(service.observe()).resolves.toEqual(sessionNotFound())

    expect(host.getState).not.toHaveBeenCalled()
    expect(host.observe).not.toHaveBeenCalled()
  })

  it('refreshes the current page identity before every observation', async () => {
    const host = createHost()
    host.openUrl.mockResolvedValue({ ok: true, state: READY_STATE })
    host.getState.mockResolvedValue({
      ok: true,
      state: {
        ...READY_STATE,
        pageId: CURRENT_PAGE_ID,
        title: 'Current page',
        url: 'https://example.com/current',
      },
    })
    host.observe.mockResolvedValue({ observation: OBSERVATION, ok: true })
    const service = createService(host)
    await service.open({ kind: 'url', url: READY_STATE.url })

    await expect(service.observe({ maxElements: 120 })).resolves.toEqual({
      observation: OBSERVATION,
      ok: true,
    })

    expect(host.getState).toHaveBeenCalledExactlyOnceWith(SESSION_ID)
    expect(host.observe).toHaveBeenCalledExactlyOnceWith({
      maxElements: 120,
      pageId: CURRENT_PAGE_ID,
      sessionId: SESSION_ID,
    })
  })

  it('classifies actions only from an immutable latest Host observation', async () => {
    const host = createHost()
    const observed: BrowserObservation = {
      ...OBSERVATION,
      elements: [{
        actions: ['click'],
        frameId: 'main-frame',
        name: 'Publish now',
        ref: 'e1',
        role: 'button',
        states: ['focusable'],
      }, {
        actions: ['fill', 'type'],
        frameId: 'main-frame',
        name: 'Search',
        ref: 'e2',
        role: 'textbox',
        states: ['editable'],
        valueState: 'empty',
      }, {
        actions: [],
        frameId: 'main-frame',
        inputMode: 'human',
        name: 'Password',
        ref: 'e3',
        role: 'textbox',
        states: ['editable'],
        valueState: 'redacted',
      }],
      pageId: PAGE_ID,
    }
    host.openUrl.mockResolvedValue({ ok: true, state: READY_STATE })
    host.getState.mockResolvedValue({ ok: true, state: READY_STATE })
    host.observe.mockResolvedValue({ observation: observed, ok: true })
    const service = createService(host)
    await service.open({ kind: 'url', url: READY_STATE.url })
    const result = await service.observe()

    const actionInput = {
      action: { kind: 'click', ref: 'e1' },
      documentRevision: 2,
      frameId: 'main-frame',
      observationId: OBSERVATION_ID,
      pageId: PAGE_ID,
    } as const
    const firstClassification = service.classifyAction(actionInput)
    expect(firstClassification).toEqual({
      approvalReview: {
        action: 'click',
        actionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        documentRevision: 2,
        effect: 'publish',
        key: null,
        observationId: OBSERVATION_ID,
        origin: 'https://example.com',
        pageId: PAGE_ID,
        risk: 'commit-like',
        sessionId: SESSION_ID,
        targetName: 'Publish now',
        targetRole: 'button',
      },
      effect: 'publish',
      risk: 'commit-like',
    })
    const pressClassification = service.classifyAction({
      ...actionInput,
      action: { key: 'Enter', kind: 'press', ref: 'e1' },
    })
    if (
      'blocked' in firstClassification
      || !firstClassification.approvalReview
      || 'blocked' in pressClassification
      || !pressClassification.approvalReview
    ) {
      throw new Error('Expected action-bound browser approval reviews')
    }
    expect(pressClassification.approvalReview.actionDigest).not.toBe(
      firstClassification.approvalReview.actionDigest,
    )
    expect(service.classifyAction({
      action: { kind: 'fill', ref: 'e2', text: 'release notes' },
      documentRevision: 2,
      frameId: 'main-frame',
      observationId: OBSERVATION_ID,
      pageId: PAGE_ID,
    })).toEqual({ risk: 'reversible-edit' })
    expect(service.classifyAction({
      action: { kind: 'fill', ref: 'e3', text: 'not-allowed' },
      documentRevision: 2,
      frameId: 'main-frame',
      observationId: OBSERVATION_ID,
      pageId: PAGE_ID,
    })).toEqual({ risk: 'sensitive-input' })

    if (result.ok)
      result.observation.elements[0]!.name = 'Open details'
    const secondClassification = service.classifyAction(actionInput)
    expect(secondClassification).toEqual({
      approvalReview: {
        action: 'click',
        actionDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        documentRevision: 2,
        effect: 'publish',
        key: null,
        observationId: OBSERVATION_ID,
        origin: 'https://example.com',
        pageId: PAGE_ID,
        risk: 'commit-like',
        sessionId: SESSION_ID,
        targetName: 'Publish now',
        targetRole: 'button',
      },
      effect: 'publish',
      risk: 'commit-like',
    })
    expect(secondClassification).toEqual(firstClassification)
    if (
      'blocked' in secondClassification
      || !secondClassification.approvalReview
    ) {
      throw new Error('Expected a browser approval binding')
    }
    host.validateAction
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        error: {
          code: 'BROWSER_TARGET_STALE',
          reason: null,
          recovery: 'read_again',
        },
        ok: false,
      })
    await expect(service.validateActionApproval(
      actionInput,
      secondClassification.approvalReview,
    )).resolves.toBeNull()
    await expect(service.validateActionApproval(
      actionInput,
      secondClassification.approvalReview,
    )).resolves.toEqual({
      blocked: true,
      reason: 'BROWSER_TARGET_STALE',
    })
    expect(host.validateAction).toHaveBeenCalledWith({
      ...actionInput,
      sessionId: SESSION_ID,
    })
    expect(service.classifyAction(actionInput)).toEqual({
      blocked: true,
      reason: 'BROWSER_TARGET_STALE',
    })
    expect(service.classifyAction({
      action: { kind: 'click', ref: 'e99' },
      documentRevision: 2,
      frameId: 'main-frame',
      observationId: OBSERVATION_ID,
      pageId: PAGE_ID,
    })).toEqual({ blocked: true, reason: 'BROWSER_TARGET_STALE' })
  })

  it('acquires one Main lease for an action and releases it after success or failure', async () => {
    const host = createHost()
    host.openUrl.mockResolvedValue({ ok: true, state: READY_STATE })
    host.getState.mockResolvedValue({ ok: true, state: READY_STATE })
    host.acquireControl
      .mockResolvedValueOnce({
        lease: {
          controller: 'agent',
          controlEpoch: 1,
          pageId: PAGE_ID,
          sessionId: SESSION_ID,
        },
        ok: true,
      })
      .mockResolvedValueOnce({
        lease: {
          controller: 'agent',
          controlEpoch: 3,
          pageId: PAGE_ID,
          sessionId: SESSION_ID,
        },
        ok: true,
      })
      .mockResolvedValueOnce({
        lease: {
          controller: 'agent',
          controlEpoch: 5,
          pageId: PAGE_ID,
          sessionId: SESSION_ID,
        },
        ok: true,
      })
    const actionSuccess = {
      actionKind: 'click',
      observation: {
        ...OBSERVATION,
        documentRevision: 3,
        observationId: POST_ACTION_OBSERVATION_ID,
        pageId: PAGE_ID,
      },
      ok: true,
      state: {
        ...READY_STATE,
        controller: 'agent',
        controlEpoch: 1,
      },
    } as const
    const actionFailure = {
      error: {
        code: 'BROWSER_TARGET_STALE',
        reason: null,
        recovery: 'read_again',
      },
      ok: false,
    } as const
    host.act
      .mockResolvedValueOnce(actionSuccess)
      .mockResolvedValueOnce(actionFailure)
      .mockRejectedValueOnce(new Error('Runtime action request failed'))
    host.releaseControl.mockResolvedValue({ ok: true })
    const service = createService(host)
    await service.open({ kind: 'url', url: READY_STATE.url })

    await expect(service.act(ACTION_INPUT)).resolves.toEqual(actionSuccess)
    expect(service.classifyAction({
      action: { amount: 'half-page', direction: 'down', kind: 'scroll' },
      documentRevision: 3,
      observationId: POST_ACTION_OBSERVATION_ID,
      pageId: PAGE_ID,
    })).toEqual({ risk: 'read' })
    await expect(service.act(ACTION_INPUT)).resolves.toEqual(actionFailure)
    await expect(service.act(ACTION_INPUT)).rejects.toThrow('Runtime action request failed')

    expect(host.acquireControl).toHaveBeenNthCalledWith(1, {
      pageId: PAGE_ID,
      sessionId: SESSION_ID,
    })
    expect(host.act).toHaveBeenNthCalledWith(1, {
      ...ACTION_INPUT,
      controlEpoch: 1,
      sessionId: SESSION_ID,
    })
    expect(host.act).toHaveBeenNthCalledWith(2, {
      ...ACTION_INPUT,
      controlEpoch: 3,
      sessionId: SESSION_ID,
    })
    expect(host.releaseControl.mock.calls).toEqual([
      [{ controlEpoch: 1, pageId: PAGE_ID, sessionId: SESSION_ID }],
      [{ controlEpoch: 3, pageId: PAGE_ID, sessionId: SESSION_ID }],
      [{ controlEpoch: 5, pageId: PAGE_ID, sessionId: SESSION_ID }],
    ])
  })

  it('releases control promptly when an in-flight action is cancelled', async () => {
    const host = createHost()
    const action = createDeferred<never>()
    host.openUrl.mockResolvedValue({ ok: true, state: READY_STATE })
    host.getState.mockResolvedValue({ ok: true, state: READY_STATE })
    host.acquireControl.mockResolvedValue({
      lease: {
        controller: 'agent',
        controlEpoch: 5,
        pageId: PAGE_ID,
        sessionId: SESSION_ID,
      },
      ok: true,
    })
    host.act.mockReturnValue(action.promise)
    host.releaseControl.mockResolvedValue({ ok: true })
    const service = createService(host)
    const phases: string[] = []
    service.onDidChange((change) => {
      if ('phase' in change)
        phases.push(change.phase)
    })
    await service.open({ kind: 'url', url: READY_STATE.url })
    const controller = new AbortController()
    const acting = service.act(ACTION_INPUT, controller.signal)
    await vi.waitFor(() => expect(host.act).toHaveBeenCalledOnce())

    controller.abort()

    await expect(acting).rejects.toMatchObject({ name: 'AbortError' })
    expect(host.releaseControl).toHaveBeenCalledExactlyOnceWith({
      controlEpoch: 5,
      pageId: PAGE_ID,
      sessionId: SESSION_ID,
    })
    let disposed = false
    const stopping = service.dispose().then(() => {
      disposed = true
    })
    await Promise.resolve()
    expect(disposed).toBe(false)
    expect(phases).toContain('caller-settled')
    expect(phases).not.toContain('response-unknown')
    action.reject(new Error('cancelled action finished later'))
    await stopping
    expect(phases.at(-1)).toBe('response-unknown')
    expect(service.snapshot.pending).toBe(0)
  })

  it('fails closed and releases a binding when Host state crosses conversation or session', async () => {
    const host = createHost()
    host.openUrl.mockResolvedValue({ ok: true, state: READY_STATE })
    host.getState.mockResolvedValue({
      ok: true,
      state: {
        ...READY_STATE,
        conversationId: 'conversation-2',
        sessionId: OTHER_SESSION_ID,
      },
    })
    const service = createService(host)
    await service.open({ kind: 'url', url: READY_STATE.url })

    await expect(service.getState()).resolves.toEqual(sessionNotFound())
    await expect(service.getState()).resolves.toEqual(sessionNotFound())

    expect(host.getState).toHaveBeenCalledOnce()
  })

  it('rejects observations that do not match the refreshed page', async () => {
    const host = createHost()
    host.openUrl.mockResolvedValue({ ok: true, state: READY_STATE })
    host.getState.mockResolvedValue({ ok: true, state: READY_STATE })
    host.observe.mockResolvedValue({
      observation: {
        ...OBSERVATION,
        pageId: CURRENT_PAGE_ID,
      },
      ok: true,
    })
    const service = createService(host)
    await service.open({ kind: 'url', url: READY_STATE.url })

    await expect(service.observe()).resolves.toEqual({
      error: {
        code: 'BROWSER_TARGET_STALE',
        reason: null,
        recovery: 'read_again',
      },
      ok: false,
    })
  })

  it('preserves Host failures and clears unavailable sessions', async () => {
    const host = createHost()
    host.openUrl
      .mockResolvedValueOnce({ ok: true, state: READY_STATE })
      .mockResolvedValueOnce({
        error: {
          code: 'BROWSER_PAGE_FAILED',
          reason: null,
          recovery: 'open_again',
        },
        ok: false,
      })
    host.getState.mockResolvedValue({
      error: {
        code: 'BROWSER_SESSION_EVICTED',
        reason: null,
        recovery: 'open_again',
      },
      ok: false,
    })
    const service = createService(host)
    await service.open({ kind: 'url', url: READY_STATE.url })

    await expect(service.getState()).resolves.toEqual({
      error: {
        code: 'BROWSER_SESSION_EVICTED',
        reason: null,
        recovery: 'open_again',
      },
      ok: false,
    })
    await expect(service.observe()).resolves.toEqual(sessionNotFound())
    await expect(service.open({
      kind: 'url',
      url: 'http://127.0.0.1:4173',
    })).resolves.toEqual({
      error: {
        code: 'BROWSER_PAGE_FAILED',
        reason: null,
        recovery: 'open_again',
      },
      ok: false,
    })

    expect(host.getState).toHaveBeenCalledOnce()
    expect(host.observe).not.toHaveBeenCalled()
  })
})

function createHost() {
  return {
    acquireControl: vi.fn(),
    act: vi.fn(),
    close: vi.fn<BrowserCapabilityHost['close']>(),
    getState: vi.fn<BrowserCapabilityHost['getState']>(),
    observe: vi.fn<BrowserCapabilityHost['observe']>(),
    openLocal: vi.fn<BrowserCapabilityHost['openLocal']>(),
    openUrl: vi.fn<BrowserCapabilityHost['openUrl']>(),
    releaseControl: vi.fn(),
    validateAction: vi.fn(),
  }
}

function createService(
  host: BrowserCapabilityHost,
  getGrants: () => readonly DirectoryGrant[] = () => [{
    canonicalRoot: '/workspace',
    grantId: 'space-1',
    kind: 'workspace' as const,
    root: '/workspace',
  }],
) {
  return new BrowserCapabilityService({
    conversationId: 'conversation-1',
    getGrants,
    host,
  })
}

function sessionNotFound() {
  return {
    error: {
      code: 'BROWSER_SESSION_NOT_FOUND',
      reason: null,
      recovery: 'open_again',
    },
    ok: false,
  } as const
}
