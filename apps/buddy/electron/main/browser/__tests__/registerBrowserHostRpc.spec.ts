import type { RuntimeRequestHandler, RuntimeRpcPeerContract } from '../../../../shared/runtime/rpcPeer'
import type { BrowserHost } from '../BrowserHost'
import { describe, expect, it, vi } from 'vitest'
import { registerBrowserHostRpc as registerHostRpc } from '../registerBrowserHostRpc'
import { createFixture } from './browserHostFixture'

const registerBrowserHostRpc: typeof registerHostRpc = (peer, options) => {
  const host = options.getHost()
  if (host) {
    host.assertOwner = vi.fn()
    host.assertControl = vi.fn()
    host.acquireControl ??= vi.fn(input => ({ ...input, controller: 'agent', controlEpoch: 1 }))
    host.releaseControl ??= vi.fn()
    host.withNetworkAuthorization = async (_session, _authorize, _signal, operation) => operation()
  }
  return registerHostRpc(peer, options)
}

const SESSION_ID = '6f828cc1-6549-4245-b26e-43b2917c9281'
const PAGE_ID = 'ed312709-baf9-44b3-a292-108055838477'
const OBSERVATION_ID = 'b3a5d63b-17b7-4b5a-863a-37f135e297d4'

const BLANK_STATE = {
  canGoBack: false,
  canGoForward: false,
  controller: 'human',
  controlEpoch: 0,
  conversationId: 'conversation-1',
  error: null,
  pageId: PAGE_ID,
  profileMode: 'default',
  security: { kind: 'blank', origin: null },
  sessionId: SESSION_ID,
  status: 'idle',
  title: '',
  url: 'about:blank',
  visible: false,
} as const

const READY_STATE = {
  ...BLANK_STATE,
  security: { kind: 'secure', origin: 'https://example.com' },
  status: 'ready',
  title: 'Example',
  url: 'https://example.com/docs',
} as const

const OBSERVATION = {
  documentRevision: 1,
  elements: [],
  observationId: OBSERVATION_ID,
  pageId: PAGE_ID,
  sessionId: SESSION_ID,
  status: 'ready',
  title: 'Example',
  truncated: false,
  url: 'https://example.com/docs',
} as const

describe('registerBrowserHostRpc', () => {
  it('rejects cross-owner requests without changing the target page network context', async () => {
    const fixture = createFixture()
    const owner = { runId: 'run-a', buddyId: 'actor-a' }
    const state = fixture.host.ensureAgentSession('task', owner)
    const request = fixture.webContents.session.webRequest.onBeforeRequest.mock.calls.at(-1)!.at(-1) as unknown as (details: object, callback: (result: object) => void) => void
    const access = () => new Promise(resolve => request({ resourceType: 'xhr', url: 'https://example.com/data', webContentsId: fixture.webContents.id }, resolve))
    const peer = createPeerFixture()
    registerHostRpc(peer.peer, { getHost: () => fixture.host })
    expect(await access()).toEqual({ cancel: false })
    const input = { sessionId: state.sessionId, pageId: state.pageId, owner: { runId: 'run-b', buddyId: 'actor-b' } }
    expect(await peer.invoke('host.browser.observe', input)).toMatchObject({ ok: false, error: { code: 'BROWSER_CONTROL_REQUIRED' } })
    expect(await peer.invoke('host.browser.read', input)).toMatchObject({ ok: false, error: { code: 'BROWSER_CONTROL_REQUIRED' } })
    expect(await access()).toEqual({ cancel: false })
    fixture.host.dispose()
    await fixture.host.whenIdle()
  })

  it('cancels a preparing execution before guest attachment without allowing a late navigation', async () => {
    const fixture = createFixture()
    fixture.createPage.mockReturnValueOnce(undefined as never)
    const owner = { runId: 'run-a', buddyId: 'actor-a' }
    const state = fixture.host.ensureAgentSession('task', owner)
    const peer = createPeerFixture()
    registerHostRpc(peer.peer, { getHost: () => fixture.host })
    const opening = peer.invoke('host.browser.open', { conversationId: 'task', owner, target: { kind: 'url', url: 'https://example.com/' } })
    await vi.waitFor(() => expect(fixture.host.getState(state.sessionId).status).toBe('loading'))
    expect(await peer.invoke('host.browser.cancel', { conversationId: 'task', owner })).toEqual({ ok: true })
    expect(await opening).toMatchObject({ ok: false, error: { code: 'BROWSER_CONTROL_REQUIRED' } })
    const page = fixture.createPage(fixture.host.getGuestDescriptor(state.sessionId))
    fixture.host.attachGuest(state.sessionId, page as never)
    expect(page.loadURL).not.toHaveBeenCalled()
    fixture.host.dispose()
    await fixture.host.whenIdle()
  })

  it('issues a strict short-lived adapter lease through the private Runtime peer', async () => {
    const fixture = createPeerFixture()
    const lease = {
      conversationId: 'conversation-1',
      expiresAt: '2026-09-02T00:01:00.000Z',
      pageId: PAGE_ID,
      protocolVersion: 1,
      sessionId: SESSION_ID,
      socketPath: '/run/user/1000/lexora-buddy/browser-adapter.sock',
      token: 'a'.repeat(64),
    }
    const createAdapterLease = vi.fn().mockReturnValue(lease)
    registerBrowserHostRpc(fixture.peer, {
      createAdapterLease,
      getHost: () => null,
    })

    await expect(fixture.invoke('host.browser.createAdapterLease', {
      conversationId: 'conversation-1',
      ttlMs: 60_000,
    })).resolves.toEqual(lease)
    await expect(fixture.invoke('host.browser.createAdapterLease', {
      conversationId: 'conversation-1',
      ttlMs: 300_001,
    })).rejects.toThrow()
  })

  it('returns stale actions and leases as recoverable results with strict contexts', async () => {
    const fixture = createPeerFixture()
    const staleTarget = Object.assign(new Error('private stale target diagnostic'), { code: 'BROWSER_TARGET_STALE' })
    const host = {
      act: vi.fn().mockRejectedValue(staleTarget),
      validateAction: vi.fn(() => { throw staleTarget }),
      releaseControl: vi.fn(() => {
        throw Object.assign(new Error('private stale lease diagnostic'), { code: 'BROWSER_CONTROL_REQUIRED' })
      }),
    } as unknown as BrowserHost
    registerBrowserHostRpc(fixture.peer, { getHost: () => host })
    const input = {
      action: { kind: 'click', ref: 'e1' },
      documentRevision: 2,
      frameId: 'main-frame',
      observationId: OBSERVATION_ID,
      pageId: PAGE_ID,
      sessionId: SESSION_ID,
    }

    for (const [method, params, code, recovery] of [
      ['host.browser.act', { ...input, controlEpoch: 1 }, 'BROWSER_TARGET_STALE', 'read_again'],
      ['host.browser.validateAction', input, 'BROWSER_TARGET_STALE', 'read_again'],
      ['host.browser.releaseControl', { controlEpoch: 1, pageId: PAGE_ID, sessionId: SESSION_ID }, 'BROWSER_CONTROL_REQUIRED', 'request_human_control'],
    ] as const) {
      const stale = await fixture.invoke(method, params)
      expect(stale).toEqual({ error: { code, reason: null, recovery }, ok: false })
      expect(JSON.stringify(stale)).not.toMatch(/private stale (?:target|lease) diagnostic/)
    }

    await expect(fixture.invoke('host.browser.act', {
      ...input,
      controlEpoch: 1,
      frameId: undefined,
    })).rejects.toThrow()
    await expect(fixture.invoke('host.browser.validateAction', {
      ...input,
      controlEpoch: 1,
    })).rejects.toThrow()
    expect(host.act).toHaveBeenCalledOnce()
    expect(host.validateAction).toHaveBeenCalledOnce()
  })

  it('returns sensitive input as an explicit human handoff without diagnostics', async () => {
    const fixture = createPeerFixture()
    const host = {
      act: vi.fn().mockRejectedValue(Object.assign(
        new Error('private sensitive target diagnostic'),
        { code: 'BROWSER_HUMAN_INPUT_REQUIRED' },
      )),
    } as unknown as BrowserHost
    registerBrowserHostRpc(fixture.peer, { getHost: () => host })

    const result = await fixture.invoke('host.browser.act', {
      action: { kind: 'fill', ref: 'e1', text: 'must-not-cross-rpc' },
      controlEpoch: 3,
      documentRevision: 2,
      frameId: 'main-frame',
      observationId: OBSERVATION_ID,
      pageId: PAGE_ID,
      sessionId: SESSION_ID,
    })

    expect(result).toEqual({
      error: {
        code: 'BROWSER_HUMAN_INPUT_REQUIRED',
        reason: null,
        recovery: 'request_human_control',
      },
      ok: false,
    })
    expect(JSON.stringify(result)).not.toContain('private sensitive target diagnostic')
  })

  it('rejects invalid page identity, script, selector, unrestricted key, and unbounded waits before Host', async () => {
    const fixture = createPeerFixture()
    const host = { act: vi.fn(), observe: vi.fn() } as unknown as BrowserHost
    registerBrowserHostRpc(fixture.peer, { getHost: () => host })
    const context = {
      controlEpoch: 1,
      documentRevision: 2,
      observationId: OBSERVATION_ID,
      pageId: PAGE_ID,
      sessionId: SESSION_ID,
    }
    const rejected = [
      {
        ...context,
        action: { kind: 'evaluate', script: 'document.body.innerHTML' },
      },
      {
        ...context,
        action: { kind: 'click', ref: 'e1', selector: '#confirm' },
        frameId: 'main-frame',
      },
      {
        ...context,
        action: { key: 'Control+Shift+I', kind: 'press' },
      },
      {
        ...context,
        action: { condition: 'network-idle', kind: 'wait', timeoutMs: 1_000 },
      },
      {
        ...context,
        action: { condition: 'page-ready', kind: 'wait', timeoutMs: 15_001 },
      },
    ]

    for (const input of rejected)
      await expect(fixture.invoke('host.browser.act', input)).rejects.toThrow()
    await expect(fixture.invoke('host.browser.observe', {
      pageId: 'not-a-uuid',
      sessionId: SESSION_ID,
    })).rejects.toThrow()
    expect(host.act).not.toHaveBeenCalled()
    expect(host.observe).not.toHaveBeenCalled()
  })

  it('preserves explicit wait results and redacts local-file paths', async () => {
    const fixture = createPeerFixture()
    const explicitUntil = {
      condition: 'text-visible' as const,
      text: 'Example',
      timeoutMs: 8_000,
    }
    const explicitOutcome = {
      condition: 'text-visible' as const,
      elapsedMs: 8_000,
      satisfied: false,
    }
    const localState = {
      ...READY_STATE,
      security: { kind: 'local', origin: 'file://' },
      title: 'Local file',
      url: 'file:///workspace/site/index.html',
    } as const
    const host = {
      ensureAgentSession: vi.fn().mockReturnValue(BLANK_STATE),
      navigate: vi.fn().mockResolvedValue({ ...READY_STATE, status: 'loading' }),
      getState: vi.fn().mockReturnValueOnce(READY_STATE).mockReturnValue(localState),
      openLocalFile: vi.fn().mockResolvedValue(localState),
      waitFor: vi.fn().mockResolvedValue(explicitOutcome),
    } as unknown as BrowserHost
    registerBrowserHostRpc(fixture.peer, { getHost: () => host })

    await expect(fixture.invoke('host.browser.open', {
      conversationId: 'conversation-1',
      owner: { runId: 'run-1', buddyId: 'default' },
      target: { kind: 'url', url: 'https://example.com/docs' },
      until: explicitUntil,
    })).resolves.toEqual({
      ok: true,
      state: {
        ...READY_STATE,
        controller: 'human',
        controlEpoch: 0,
        profileMode: 'default',
      },
      until: explicitOutcome,
    })
    await expect(fixture.invoke('host.browser.open', {
      conversationId: 'conversation-1',
      owner: { runId: 'run-1', buddyId: 'default' },
      target: {
        entryPath: '/workspace/site/index.html',
        kind: 'local-file',
        rootPath: '/workspace',
      },
    })).resolves.toEqual({
      ok: true,
      state: {
        ...localState,
        controller: 'human',
        controlEpoch: 0,
        profileMode: 'default',
        url: 'file:///[redacted]',
      },
    })

    expect(host.waitFor).toHaveBeenCalledTimes(1)
  })

  it('preserves a bounded browser security reason without exposing diagnostics', async () => {
    const fixture = createPeerFixture()
    const host = {
      ensureAgentSession: vi.fn().mockReturnValue(BLANK_STATE),
      navigate: vi.fn().mockRejectedValue(Object.assign(
        new Error('blocked browser request must not cross RPC'),
        {
          code: 'BROWSER_NAVIGATION_BLOCKED',
          reason: 'NETWORK_POLICY_BLOCKED',
        },
      )),
    } as unknown as BrowserHost
    registerBrowserHostRpc(fixture.peer, { getHost: () => host })

    const result = await fixture.invoke('host.browser.open', {
      conversationId: 'conversation-1',
      owner: { runId: 'run-1', buddyId: 'default' },
      target: { kind: 'url', url: 'https://example.com/' },
    })

    expect(result).toEqual({
      error: {
        code: 'BROWSER_NAVIGATION_BLOCKED',
        reason: 'NETWORK_POLICY_BLOCKED',
        recovery: null,
      },
      ok: false,
    })
    expect(JSON.stringify(result)).not.toContain('blocked browser request')
  })

  it('removes URL query and fragment before Main returns browser state or observations', async () => {
    const fixture = createPeerFixture()
    const privateUrl = 'https://example.com/docs?access_token=query-secret#fragment-secret'
    const host = {
      ensureAgentSession: vi.fn().mockReturnValue(BLANK_STATE),
      getState: vi.fn().mockReturnValue({ ...READY_STATE, url: privateUrl }),
      navigate: vi.fn().mockResolvedValue({ ...READY_STATE, url: privateUrl }),
      observe: vi.fn().mockResolvedValue({ ...OBSERVATION, url: privateUrl }),
    } as unknown as BrowserHost
    registerBrowserHostRpc(fixture.peer, { getHost: () => host })

    const opened = await fixture.invoke('host.browser.open', {
      conversationId: 'conversation-1',
      owner: { runId: 'run-1', buddyId: 'default' },
      target: { kind: 'url', url: privateUrl },
    })
    const observed = await fixture.invoke('host.browser.observe', {
      pageId: PAGE_ID,
      sessionId: SESSION_ID,
    })
    const state = await fixture.invoke('host.browser.getState', {
      sessionId: SESSION_ID,
    })

    expect(opened).toMatchObject({ state: { url: 'https://example.com/docs' } })
    expect(observed).toMatchObject({
      observation: { url: 'https://example.com/docs' },
    })
    expect(state).toMatchObject({ state: { url: 'https://example.com/docs' } })
    expect(JSON.stringify({ opened, observed, state })).not.toMatch(
      /query-secret|fragment-secret/,
    )
  })

  it('fails closed when the browser window or semantic observer is unavailable', async () => {
    const unavailable = createPeerFixture()
    registerBrowserHostRpc(unavailable.peer, { getHost: () => null })

    await expect(unavailable.invoke('host.browser.open', {
      conversationId: 'conversation-1',
      owner: { runId: 'run-1', buddyId: 'default' },
      target: { kind: 'url', url: 'https://example.com' },
    })).resolves.toEqual({
      error: {
        code: 'BROWSER_SESSION_NOT_FOUND',
        reason: null,
        recovery: 'open_again',
      },
      ok: false,
    })

    const observerFailure = createPeerFixture()
    const host = {
      observe: vi.fn().mockRejectedValue(new Error('observer is not ready')),
    } as unknown as BrowserHost
    registerBrowserHostRpc(observerFailure.peer, { getHost: () => host })

    await expect(observerFailure.invoke('host.browser.observe', {
      pageId: PAGE_ID,
      sessionId: SESSION_ID,
    })).resolves.toEqual({
      error: {
        code: 'BROWSER_PAGE_FAILED',
        reason: null,
        recovery: 'read_again',
      },
      ok: false,
    })
  })
})

function createPeerFixture() {
  const handlers = new Map<string, RuntimeRequestHandler>()
  const peer = {
    onRequest: (method: string, handler: RuntimeRequestHandler) => {
      handlers.set(method, handler)
      return () => handlers.delete(method)
    },
  } as unknown as RuntimeRpcPeerContract
  return {
    invoke(method: string, params: unknown) {
      const handler = handlers.get(method)
      if (!handler)
        throw new Error(`Runtime Host RPC handler was not registered: ${method}`)
      return Promise.resolve().then(() => handler(params))
    },
    peer,
  }
}
