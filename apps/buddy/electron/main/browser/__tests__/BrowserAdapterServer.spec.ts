import type { BrowserActParams, BrowserObservation } from '../../../../shared/browser'
import type { BrowserAdapterResponse } from '../../../../shared/browser/browserAdapterProtocol'
import type { DesktopBrowserState } from '../../../shared/desktopApi'
import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { localTransports } from '../../../../platform/ipc/localTransport'
import {
  BROWSER_ADAPTER_PROTOCOL_VERSION,
} from '../../../../shared/browser/browserAdapterProtocol'
import { BrowserAdapterServer } from '../BrowserAdapterServer'

const conversationId = 'conversation-browser-adapter'
const sessionId = '6f828cc1-6549-4245-b26e-43b2917c9281'
const pageId = 'ed312709-baf9-44b3-a292-108055838477'
const observationId = 'cece2ce7-4a79-478a-9008-c0df264095ba'
const token = 'a'.repeat(64)

const activeServers: BrowserAdapterServer[] = []
const temporaryDirectories: string[] = []

function createObservation(): BrowserObservation {
  return {
    documentRevision: 1,
    elements: [],
    observationId,
    pageId,
    sessionId,
    status: 'ready',
    title: 'Adapter fixture',
    truncated: false,
    url: 'http://127.0.0.1:43100/?secret=query#fragment',
  }
}

afterEach(async () => {
  await Promise.all(activeServers.splice(0).map(server => server.dispose()))
  await Promise.all(temporaryDirectories.splice(0).map(directory => (
    rm(directory, { force: true, recursive: true })
  )))
})

describe('browserAdapterServer', () => {
  it('authenticates a short-lived capability bound to the current conversation session', async () => {
    let now = Date.parse('2026-09-02T00:00:00.000Z')
    const fixture = await createFixture({ now: () => now })
    const lease = fixture.server.issueLease({ conversationId })

    expect(lease).toMatchObject({
      conversationId,
      expiresAt: '2026-09-02T00:01:00.000Z',
      pageId,
      protocolVersion: BROWSER_ADAPTER_PROTOCOL_VERSION,
      sessionId,
      socketPath: fixture.socketPath,
      token,
    })
    expect(await sendRequest(fixture.socketPath, request('state', {}, token))).toMatchObject({
      ok: true,
      result: { kind: 'state', state: { conversationId, pageId, sessionId } },
    })
    expect(await sendRequest(
      fixture.socketPath,
      request('state', {}, 'b'.repeat(64)),
    )).toMatchObject({
      error: { code: 'BROWSER_ADAPTER_AUTH_FAILED' },
      ok: false,
    })

    now += 60_001
    expect(await sendRequest(fixture.socketPath, request('state', {}, token))).toMatchObject({
      error: { code: 'BROWSER_ADAPTER_LEASE_EXPIRED' },
      ok: false,
    })
  })

  it('validates, acquires, executes, and releases each safe action on the same session', async () => {
    const fixture = await createFixture()
    fixture.server.issueLease({ conversationId })

    const params = {
      action: { kind: 'reload' as const },
      documentRevision: 1,
      observationId,
      pageId,
    }
    const response = await sendRequest(
      fixture.socketPath,
      request('action', params, token),
    )

    expect(fixture.calls).toEqual([
      'state',
      'validate',
      'acquire',
      'act',
      'release',
      'state',
    ])
    expect(fixture.host.validateAction).toHaveBeenCalledWith({ ...params, sessionId })
    expect(fixture.host.act).toHaveBeenCalledWith({
      ...params,
      controlEpoch: 1,
      sessionId,
    })
    expect(response).toMatchObject({
      ok: true,
      result: {
        actionKind: 'reload',
        kind: 'action',
        observation: {
          observationId,
          pageId,
          sessionId,
          url: 'http://127.0.0.1:43100/',
        },
        state: { controller: 'human', pageId, sessionId },
      },
    })
  })

  it('only releases an in-flight action when its owning connection disconnects', async () => {
    const fixture = await createFixture()
    fixture.server.issueLease({ conversationId })
    let finishAction: (() => void) | undefined
    fixture.host.act.mockImplementationOnce((input: BrowserActParams) => new Promise((resolve) => {
      finishAction = () => resolve({
        actionKind: input.action.kind,
        observation: createObservation(),
        state: fixture.host.getState(sessionId),
      })
    }))
    const actionSocket = await connectSocket(fixture.socketPath)
    actionSocket.write(`${JSON.stringify(request('action', {
      action: { kind: 'reload' },
      documentRevision: 1,
      observationId,
      pageId,
    }, token))}\n`)
    await vi.waitFor(() => expect(fixture.host.acquireControl).toHaveBeenCalledOnce())

    expect(await sendRequest(
      fixture.socketPath,
      request('state', {}, token),
    )).toMatchObject({ ok: true })
    await new Promise(resolve => setImmediate(resolve))
    expect(fixture.host.releaseControl).not.toHaveBeenCalled()

    actionSocket.destroy()
    await vi.waitFor(() => expect(fixture.host.releaseControl).toHaveBeenCalledOnce())
    finishAction?.()
  })

  it('fails closed before acquiring control for commit-like activation', async () => {
    const fixture = await createFixture()
    fixture.server.issueLease({ conversationId })

    const response = await sendRequest(fixture.socketPath, request('action', {
      action: { kind: 'click', ref: 'e1' },
      documentRevision: 1,
      frameId: 'main-frame',
      observationId,
      pageId,
    }, token))

    expect(fixture.host.validateAction).toHaveBeenCalledOnce()
    expect(fixture.host.acquireControl).not.toHaveBeenCalled()
    expect(response).toMatchObject({
      error: {
        code: 'BROWSER_ADAPTER_APPROVAL_REQUIRED',
        recovery: 'request_buddy_approval',
      },
      ok: false,
    })
  })

  it('revokes only the adapter capability on close and keeps the browser page alive', async () => {
    const fixture = await createFixture()
    fixture.server.issueLease({ conversationId })

    expect(await sendRequest(fixture.socketPath, request('close', {}, token))).toMatchObject({
      ok: true,
      result: { kind: 'close', revoked: true },
    })
    expect(fixture.host.getState(sessionId)).toMatchObject({ pageId, sessionId })
    expect(await sendRequest(fixture.socketPath, request('state', {}, token))).toMatchObject({
      error: { code: 'BROWSER_ADAPTER_AUTH_FAILED' },
      ok: false,
    })
  })

  it('revokes capabilities immediately when the bound BrowserSession is destroyed', async () => {
    const fixture = await createFixture()
    fixture.server.issueLease({ conversationId })

    fixture.server.revokeSession(sessionId)

    expect(await sendRequest(fixture.socketPath, request('state', {}, token))).toMatchObject({
      error: { code: 'BROWSER_ADAPTER_AUTH_FAILED' },
      ok: false,
    })
  })

  it('rejects oversized or structurally invalid requests without exposing diagnostics', async () => {
    const fixture = await createFixture()
    fixture.server.issueLease({ conversationId })
    const invalid = await sendLine(fixture.socketPath, JSON.stringify({
      ...request('state', {}, token),
      extra: true,
    }))
    expect(invalid).toEqual({
      error: {
        code: 'BROWSER_ADAPTER_REQUEST_INVALID',
        recovery: null,
      },
      id: 'request-1',
      ok: false,
      protocolVersion: 1,
    })

    const oversized = await sendLine(fixture.socketPath, 'x'.repeat(64 * 1_024 + 1))
    expect(oversized).toMatchObject({
      error: { code: 'BROWSER_ADAPTER_REQUEST_INVALID' },
      ok: false,
    })
    expect(JSON.stringify(oversized)).not.toContain('Unexpected token')
  })
})

async function createFixture(options: { now?: () => number } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'lexora-browser-adapter-'))
  temporaryDirectories.push(directory)
  const socketPath = join(directory, 'browser-adapter.sock')
  const state: DesktopBrowserState = {
    zoomFactor: 1,
    canGoBack: false,
    canGoForward: false,
    controller: 'human',
    controlEpoch: 0,
    conversationId,
    error: null,
    pageId,
    profileMode: 'default',
    security: { kind: 'local', origin: 'http://127.0.0.1:43100' },
    sessionId,
    status: 'ready',
    title: 'Adapter fixture',
    url: 'http://127.0.0.1:43100/?secret=query#fragment',
    visible: true,
  }
  const observation = createObservation()
  const calls: string[] = []
  const host = {
    acquireControl: vi.fn(() => {
      calls.push('acquire')
      state.controller = 'agent'
      state.controlEpoch = 1
      return {
        controller: 'agent' as const,
        controlEpoch: 1,
        pageId,
        sessionId,
      }
    }),
    act: vi.fn(async (input: BrowserActParams) => {
      calls.push('act')
      return {
        actionKind: input.action.kind,
        observation,
        state: { ...state },
      }
    }),
    getState: vi.fn((_sessionId: string) => {
      calls.push('state')
      return { ...state }
    }),
    getStateForConversation: vi.fn(() => ({ ...state })),
    observe: vi.fn(async () => {
      calls.push('observe')
      return observation
    }),
    releaseControl: vi.fn(() => {
      calls.push('release')
      state.controller = 'human'
      state.controlEpoch = 2
      return { ...state }
    }),
    validateAction: vi.fn(() => {
      calls.push('validate')
    }),
  }
  const server = new BrowserAdapterServer({
    createToken: () => token,
    getHost: () => host,
    now: options.now,
    endpoint: localTransports.unix(socketPath),
  })
  activeServers.push(server)
  await server.start()
  calls.length = 0
  return { calls, host, server, socketPath }
}

function request(method: string, params: unknown, credential: string) {
  return {
    id: 'request-1',
    method,
    params,
    protocolVersion: BROWSER_ADAPTER_PROTOCOL_VERSION,
    token: credential,
  }
}

function sendRequest(
  socketPath: string,
  input: unknown,
): Promise<BrowserAdapterResponse> {
  return sendLine(socketPath, JSON.stringify(input))
}

function sendLine(socketPath: string, line: string): Promise<BrowserAdapterResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    let response: BrowserAdapterResponse | undefined
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(`${line}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0)
        return
      response = JSON.parse(buffer.slice(0, newline))
      socket.end()
    })
    socket.on('error', reject)
    socket.on('close', () => {
      if (response)
        resolve(response)
      else
        rejectIfUnresolved(reject, buffer)
    })
  })
}

function connectSocket(socketPath: string) {
  return new Promise<ReturnType<typeof createConnection>>((resolve, reject) => {
    const socket = createConnection(socketPath)
    socket.once('connect', () => resolve(socket))
    socket.once('error', reject)
  })
}

function rejectIfUnresolved(
  reject: (reason?: unknown) => void,
  buffer: string,
): void {
  if (!buffer.includes('\n'))
    reject(new Error('Browser adapter socket closed without a response'))
}
