import type { RuntimeRequestHandler, RuntimeRpcPeerContract } from '../../../../shared/runtime/rpcPeer'
import type { BrowserHost } from '../BrowserHost'
import { describe, expect, it, vi } from 'vitest'
import { registerBrowserHostRpc as registerHostRpc } from '../registerBrowserHostRpc'

const registerBrowserHostRpc: typeof registerHostRpc = (peer, options) => {
  const host = options.getHost()
  if (host)
    host.withNetworkAuthorization = async (_session, _authorize, _signal, operation) => operation()
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
    expect(createAdapterLease).toHaveBeenCalledExactlyOnceWith({
      conversationId: 'conversation-1',
      ttlMs: 60_000,
    })
    await expect(fixture.invoke('host.browser.createAdapterLease', {
      conversationId: 'conversation-1',
      ttlMs: 300_001,
    })).rejects.toThrow()
  })

  it('acquires and releases page-bound control through Runtime-only methods', async () => {
    const fixture = createPeerFixture()
    const host = {
      acquireControl: vi.fn().mockReturnValue({
        controller: 'agent',
        controlEpoch: 4,
        pageId: PAGE_ID,
        sessionId: SESSION_ID,
      }),
      releaseControl: vi.fn()
        .mockReturnValueOnce({
          ...READY_STATE,
          controller: 'human',
          controlEpoch: 5,
        })
        .mockImplementationOnce(() => {
          throw Object.assign(new Error('old runtime lease'), {
            code: 'BROWSER_CONTROL_REQUIRED',
          })
        }),
    } as unknown as BrowserHost
    registerBrowserHostRpc(fixture.peer, { getHost: () => host })

    await expect(fixture.invoke('host.browser.acquireControl', {
      pageId: PAGE_ID,
      sessionId: SESSION_ID,
    })).resolves.toEqual({
      lease: {
        controller: 'agent',
        controlEpoch: 4,
        pageId: PAGE_ID,
        sessionId: SESSION_ID,
      },
      ok: true,
    })
    await expect(fixture.invoke('host.browser.releaseControl', {
      controlEpoch: 4,
      pageId: PAGE_ID,
      sessionId: SESSION_ID,
    })).resolves.toEqual({ ok: true })
    await expect(fixture.invoke('host.browser.releaseControl', {
      controlEpoch: 4,
      pageId: PAGE_ID,
      sessionId: SESSION_ID,
    })).resolves.toEqual({
      error: {
        code: 'BROWSER_CONTROL_REQUIRED',
        reason: null,
        recovery: 'request_human_control',
      },
      ok: false,
    })
  })

  it('returns stale action targets as a recoverable observe-again result', async () => {
    const fixture = createPeerFixture()
    const host = {
      act: vi.fn()
        .mockResolvedValueOnce({
          actionKind: 'click',
          observation: OBSERVATION,
          state: READY_STATE,
        })
        .mockRejectedValueOnce(Object.assign(
          new Error('private stale target diagnostic'),
          { code: 'BROWSER_TARGET_STALE' },
        )),
    } as unknown as BrowserHost
    registerBrowserHostRpc(fixture.peer, { getHost: () => host })
    const input = {
      action: { kind: 'click', ref: 'e1' },
      controlEpoch: 1,
      documentRevision: 2,
      frameId: 'main-frame',
      observationId: OBSERVATION_ID,
      pageId: PAGE_ID,
      sessionId: SESSION_ID,
    }

    await expect(fixture.invoke('host.browser.act', input)).resolves.toEqual({
      actionKind: 'click',
      observation: OBSERVATION,
      ok: true,
      state: {
        ...READY_STATE,
        controller: 'human',
        controlEpoch: 0,
        profileMode: 'default',
      },
    })
    const stale = await fixture.invoke('host.browser.act', input)
    expect(stale).toEqual({
      error: {
        code: 'BROWSER_TARGET_STALE',
        reason: null,
        recovery: 'read_again',
      },
      ok: false,
    })
    expect(JSON.stringify(stale)).not.toContain('private stale target diagnostic')

    await expect(fixture.invoke('host.browser.act', {
      ...input,
      frameId: undefined,
    })).rejects.toThrow()
    expect(host.act).toHaveBeenCalledTimes(2)
  })

  it('revalidates an approved action without acquiring control or exposing diagnostics', async () => {
    const fixture = createPeerFixture()
    const host = {
      validateAction: vi.fn()
        .mockReturnValueOnce(undefined)
        .mockImplementationOnce(() => {
          throw Object.assign(new Error('private changed-page diagnostic'), {
            code: 'BROWSER_TARGET_STALE',
          })
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

    await expect(fixture.invoke('host.browser.validateAction', input))
      .resolves
      .toEqual({ ok: true })
    const stale = await fixture.invoke('host.browser.validateAction', input)
    expect(stale).toEqual({
      error: {
        code: 'BROWSER_TARGET_STALE',
        reason: null,
        recovery: 'read_again',
      },
      ok: false,
    })
    expect(JSON.stringify(stale)).not.toContain('private changed-page diagnostic')

    await expect(fixture.invoke('host.browser.validateAction', {
      ...input,
      controlEpoch: 1,
    })).rejects.toThrow()
    expect(host.validateAction).toHaveBeenCalledTimes(2)
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

  it('rejects script, selector, unrestricted key, and unbounded wait payloads before Host', async () => {
    const fixture = createPeerFixture()
    const host = { act: vi.fn() } as unknown as BrowserHost
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
    expect(host.act).not.toHaveBeenCalled()
  })

  it('opens URL and granted local targets through the same BrowserHost session', async () => {
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
      ensureSession: vi.fn().mockReturnValue(BLANK_STATE),
      navigate: vi.fn().mockResolvedValue({ ...READY_STATE, status: 'loading' }),
      getState: vi.fn().mockReturnValue(READY_STATE),
      openLocalFile: vi.fn().mockResolvedValue(localState),
      waitFor: vi.fn()
        .mockResolvedValueOnce(explicitOutcome)
        .mockResolvedValueOnce({
          condition: 'dom-stable',
          elapsedMs: 1_500,
          satisfied: false,
        }),
    } as unknown as BrowserHost
    registerBrowserHostRpc(fixture.peer, { getHost: () => host })

    await expect(fixture.invoke('host.browser.open', {
      conversationId: 'conversation-1',
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

    expect(host.ensureSession).toHaveBeenCalledTimes(2)
    expect(host.ensureSession).toHaveBeenNthCalledWith(1, 'conversation-1')
    expect(host.ensureSession).toHaveBeenNthCalledWith(2, 'conversation-1')
    expect(host.navigate).toHaveBeenCalledExactlyOnceWith(
      SESSION_ID,
      'https://example.com/docs',
      'document-ready',
    )
    expect(host.openLocalFile).toHaveBeenCalledExactlyOnceWith(SESSION_ID, {
      entryPath: '/workspace/site/index.html',
      rootPath: '/workspace',
    }, 'document-ready')
    expect(host.waitFor).toHaveBeenNthCalledWith(1, SESSION_ID, explicitUntil)
    expect(host.waitFor).toHaveBeenCalledTimes(1)
  })

  it('preserves a bounded browser security reason without exposing diagnostics', async () => {
    const fixture = createPeerFixture()
    const host = {
      ensureSession: vi.fn().mockReturnValue(BLANK_STATE),
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

  it('validates, observes, reads, and closes without exposing host diagnostics', async () => {
    const fixture = createPeerFixture()
    const host = {
      close: vi.fn(),
      getState: vi.fn()
        .mockReturnValueOnce({
          ...READY_STATE,
          controller: 'agent',
          controlEpoch: 7,
        })
        .mockImplementationOnce(() => {
          throw Object.assign(new Error('private host diagnostic'), {
            code: 'BROWSER_SESSION_NOT_FOUND',
          })
        }),
      observe: vi.fn().mockResolvedValue(OBSERVATION),
    } as unknown as BrowserHost
    registerBrowserHostRpc(fixture.peer, { getHost: () => host })

    await expect(fixture.invoke('host.browser.observe', {
      maxElements: 160,
      pageId: PAGE_ID,
      sessionId: SESSION_ID,
    })).resolves.toEqual({ observation: OBSERVATION, ok: true })
    await expect(fixture.invoke('host.browser.getState', {
      sessionId: SESSION_ID,
    })).resolves.toMatchObject({
      ok: true,
      state: {
        controller: 'agent',
        controlEpoch: 7,
        profileMode: 'default',
        sessionId: SESSION_ID,
      },
    })
    await expect(fixture.invoke('host.browser.close', {
      sessionId: SESSION_ID,
    })).resolves.toEqual({ ok: true })

    const failure = await fixture.invoke('host.browser.getState', {
      sessionId: SESSION_ID,
    })
    expect(failure).toEqual({
      error: {
        code: 'BROWSER_SESSION_NOT_FOUND',
        reason: null,
        recovery: 'open_again',
      },
      ok: false,
    })
    expect(JSON.stringify(failure)).not.toContain('private host diagnostic')

    await expect(fixture.invoke('host.browser.observe', {
      pageId: 'not-a-uuid',
      sessionId: SESSION_ID,
    })).rejects.toThrow()
    expect(host.observe).toHaveBeenCalledOnce()
    expect(host.close).toHaveBeenCalledExactlyOnceWith(SESSION_ID)
  })

  it('removes URL query and fragment before Main returns browser state or observations', async () => {
    const fixture = createPeerFixture()
    const privateUrl = 'https://example.com/docs?access_token=query-secret#fragment-secret'
    const host = {
      ensureSession: vi.fn().mockReturnValue(BLANK_STATE),
      getState: vi.fn().mockReturnValue({ ...READY_STATE, url: privateUrl }),
      navigate: vi.fn().mockResolvedValue({ ...READY_STATE, url: privateUrl }),
      observe: vi.fn().mockResolvedValue({ ...OBSERVATION, url: privateUrl }),
      waitFor: vi.fn().mockResolvedValue({
        condition: 'dom-stable',
        elapsedMs: 300,
        satisfied: true,
      }),
    } as unknown as BrowserHost
    registerBrowserHostRpc(fixture.peer, { getHost: () => host })

    const opened = await fixture.invoke('host.browser.open', {
      conversationId: 'conversation-1',
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
    onRequest: vi.fn((method: string, handler: RuntimeRequestHandler) => {
      handlers.set(method, handler)
      return () => handlers.delete(method)
    }),
  } as unknown as RuntimeRpcPeerContract
  return {
    handlers,
    invoke(method: string, params: unknown) {
      const handler = handlers.get(method)
      if (!handler)
        throw new Error(`Runtime Host RPC handler was not registered: ${method}`)
      return Promise.resolve().then(() => handler(params))
    },
    peer,
  }
}
