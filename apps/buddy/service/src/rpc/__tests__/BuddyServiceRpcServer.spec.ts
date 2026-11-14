import type { ApplicationDiagnostic } from '../../../../shared/diagnostics/applicationDiagnostic'
import { EventEmitter } from 'node:events'
import { ModelsError } from '@earendil-works/pi-ai'
import { describe, expect, it, vi } from 'vitest'
import { BUDDY_SERVICE_PROTOCOL_VERSION } from '../../../../shared/runtime/runtimeProtocol'
import { diagnosticContext } from '../../diagnostics/diagnosticContext'
import { HostCredentialStoreError } from '../../providers/HostCredentialStore'

import {
  createBuddyService as createService,
  notifyBuddyServiceReady,
} from '../BuddyServiceRpcServer'

class FakeParentPort extends EventEmitter {
  readonly sent: unknown[] = []

  postMessage(message: unknown): void {
    this.sent.push(message)
  }

  receive(message: unknown): void {
    this.emit('message', { data: message })
  }
}

describe('runtimeRpcServer', () => {
  it('carries request identity through async work and suppresses only successful routine polling', async () => {
    const port = new FakeParentPort()
    const diagnostics: ApplicationDiagnostic[] = []
    const server = createBuddyService({ announceReady: false, port, recordDiagnostic: event => diagnostics.push(event) })
    server.onRequest('chat.queue.list', async (params) => {
      await new Promise(resolve => setImmediate(resolve))
      if (params)
        throw new Error('private-error')
      return { operationId: diagnosticContext.getStore()?.operationId }
    })
    port.receive({ jsonrpc: '2.0', id: 'poll-ok', method: 'chat.queue.list', params: null })
    port.receive({ jsonrpc: '2.0', id: 'poll-failed', method: 'chat.queue.list', params: true })
    await vi.waitFor(() => expect(port.sent).toHaveLength(2))
    expect(port.sent[0]).toMatchObject({ id: 'poll-ok', result: { operationId: 'poll-ok' } })
    expect(diagnostics).toEqual([expect.objectContaining({ operationId: 'poll-failed', event: 'rpc.handler.failed', level: 'error' })])
    expect(JSON.stringify(diagnostics)).not.toContain('private-error')
    server.close(new Error('test completed'))
  })

  it.each([
    ['CREDENTIAL_STORE_UNAVAILABLE', 'CREDENTIAL_STORE_UNAVAILABLE', 'CREDENTIAL_STORE_UNAVAILABLE'],
    ['PRIVATE_DIAGNOSTIC', 'BUDDY_RUNTIME_REQUEST_FAILED', 'OPERATION_FAILED'],
  ])('reports a Pi-wrapped %s without exposing private error content', async (causeCode, wireCode, diagnosticCode) => {
    const port = new FakeParentPort()
    const diagnostics: ApplicationDiagnostic[] = []
    const server = createBuddyService({ announceReady: false, port, recordDiagnostic: event => diagnostics.push(event) })
    const cause = new HostCredentialStoreError(causeCode)
    server.onRequest('providers.login', () => {
      throw new ModelsError('auth', 'private-provider-diagnostic', { cause })
    })

    port.receive({ jsonrpc: '2.0', id: 'login-1', method: 'providers.login', params: {} })
    await new Promise(resolve => setImmediate(resolve))

    expect(port.sent).toEqual([{
      jsonrpc: '2.0',
      id: 'login-1',
      error: {
        code: -32_000,
        message: 'Lexora Buddy runtime request failed',
        data: { code: wireCode, retryable: false },
      },
    }])
    expect(diagnostics.at(-1)).toMatchObject({
      event: 'rpc.handler.failed',
      method: 'providers.login',
      errorType: 'ModelsError',
      errorCode: diagnosticCode,
    })
    expect(JSON.stringify({ diagnostics, messages: port.sent })).not.toContain('private-provider-diagnostic')
    server.close(new Error('test completed'))
  })

  it('does not report readiness before startup recovery completes', async () => {
    const port = new FakeParentPort()
    const server = createBuddyService({ announceReady: false, port })

    port.receive({
      jsonrpc: '2.0',
      id: 'status-starting',
      method: 'runtime.status',
      params: {},
    })
    port.receive({
      jsonrpc: '2.0',
      id: 'state-starting',
      method: 'runtime.localState',
      params: {},
    })
    await new Promise(resolve => setImmediate(resolve))

    expect(port.sent).toEqual([
      {
        jsonrpc: '2.0',
        id: 'status-starting',
        result: {
          name: 'lexora-buddy-service',
          protocolVersion: BUDDY_SERVICE_PROTOCOL_VERSION,
          ready: false,
        },
      },
      {
        jsonrpc: '2.0',
        id: 'state-starting',
        result: { status: 'starting' },
      },
    ])

    notifyBuddyServiceReady(server)

    port.receive({
      jsonrpc: '2.0',
      id: 'status-ready',
      method: 'runtime.status',
      params: {},
    })
    await new Promise(resolve => setImmediate(resolve))

    expect(port.sent.slice(2)).toEqual([
      {
        jsonrpc: '2.0',
        method: 'runtime.ready',
        params: {
          name: 'lexora-buddy-service',
          protocolVersion: BUDDY_SERVICE_PROTOCOL_VERSION,
        },
      },
      {
        jsonrpc: '2.0',
        id: 'status-ready',
        result: {
          name: 'lexora-buddy-service',
          protocolVersion: BUDDY_SERVICE_PROTOCOL_VERSION,
          ready: true,
        },
      },
    ])
  })

  it('refuses idle-only shutdown while busy and closes task admission atomically once idle', async () => {
    const port = new FakeParentPort()
    let busy = true
    let stopped = false
    let turns = 0
    const server = createBuddyService({ port, prepareIdleShutdown: () => !busy, scheduleShutdown: () => {
      stopped = true
    } })
    server.onRequest('chat.startTurn', () => ({ runId: `run-${++turns}` }))
    const send = (id: string, method: string, params: unknown = {}) => port.receive({ jsonrpc: '2.0', id, method, params })
    send('busy', 'runtime.shutdown', { onlyIfIdle: true })
    send('continued', 'chat.startTurn')
    await new Promise(resolve => setImmediate(resolve))
    expect(port.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'busy', result: { accepted: false } }),
      expect.objectContaining({ id: 'continued', result: { runId: 'run-1' } }),
    ]))
    expect(stopped).toBe(false)
    busy = false
    send('idle', 'runtime.shutdown', { onlyIfIdle: true })
    send('late', 'chat.startTurn')
    await new Promise(resolve => setImmediate(resolve))
    expect(port.sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'idle', result: { accepted: true } }),
      expect.objectContaining({ id: 'late', error: expect.objectContaining({ data: expect.objectContaining({ code: 'RUNTIME_UNAVAILABLE' }) }) }),
    ]))
    expect(turns).toBe(1)
    expect(stopped).toBe(true)
    server.close(new Error('test completed'))
  })
})

function createBuddyService(options: Omit<Parameters<typeof createService>[0], 'scheduleShutdown'> & { scheduleShutdown?: () => void }) {
  return createService({ scheduleShutdown() {}, ...options })
}
