import type { SandboxCommand } from '../../../../shared/permissions/shellSandbox'
import type { RuntimeRpcPeerContract } from '../../../../shared/runtime/rpcPeer'
import type { SandboxClientEvent } from '../ShellSandboxClient'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it } from 'vitest'
import { diagnosticContext } from '../../diagnostics/diagnosticContext'
import { observeSandboxClient } from '../observeSandboxClient'
import { ShellSandboxClient } from '../ShellSandboxClient'

function fixture() {
  const response = deferred<unknown>()
  const notifications: Array<{ method: string, params: unknown }> = []
  const listeners = new Set<(method: string, params: unknown) => void>()
  let requestId = ''
  const peer: RuntimeRpcPeerContract = {
    notify: (method, params) => { notifications.push({ method, params }) },
    onNotification: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    onRequest: () => () => {},
    request: async (_method, params) => {
      requestId = (params as SandboxCommand).requestId
      return response.promise
    },
    close: () => {},
  }
  const client = new ShellSandboxClient(peer)
  const controller = new AbortController()
  const events: SandboxClientEvent[] = []
  client.onDidChange(event => events.push(event))
  const execute = () => client.exec({ command: 'private command text', cwd: '/workspace', roots: ['/workspace'], workspaceRoots: [], resourceReadRoots: [], additionalDirectories: [], readOnly: true }, { onData: () => {}, signal: controller.signal }, async () => false)
  return { client, controller, events, execute, notifications, response, backend(revision: number, kind: string, result?: unknown) {
    for (const listener of listeners) listener('host.sandbox.lifecycle', { requestId, revision, kind, snapshot: { phase: kind === 'settled' ? 'finished' : 'running', started: true, waiting: 0, cancellation: 'none', ...result ? { result } : {} } })
  } }
}

describe('sandbox client facts', () => {
  it('retains tool correlation across incoming backend notifications outside the original async scope', async () => {
    const f = fixture()
    const records: import('../../../../shared/diagnostics/applicationDiagnostic').ApplicationDiagnostic[] = []
    const subscription = observeSandboxClient(f.client, event => records.push(event))
    const pending = diagnosticContext.run({ runId: 'run-fixture', toolCallId: 'tool-fixture' }, f.execute)
    f.backend(1, 'started')
    f.response.resolve({ ok: true, exitCode: 0 })
    await pending
    expect(records).toHaveLength(3)
    expect(records.every(event => event.runId === 'run-fixture' && event.toolCallId === 'tool-fixture')).toBe(true)
    subscription.dispose()
    await f.client.dispose()
  })

  it('keeps successful settlement distinct from cleanup and ignores stale backend messages', async () => {
    const f = fixture()
    const pending = f.execute()
    f.backend(2, 'started')
    f.backend(1, 'started')
    f.backend(3, 'settled', { ok: true, exitCode: 0 })
    f.response.resolve({ ok: true, exitCode: 0 })
    await expect(pending).resolves.toEqual({ exitCode: 0 })
    f.controller.abort()
    await f.client.dispose()
    expect(f.notifications).toEqual([])
    expect(f.events.map(event => event.kind)).toEqual(['requested', 'backend', 'backend', 'returned'])
    expect(JSON.stringify(f.events)).not.toContain('private command')
    const backend = f.events.find(event => event.kind === 'backend')
    expect(backend?.kind === 'backend' && Object.isFrozen(backend.event.snapshot)).toBe(true)
  })

  it('reports cancellation immediately and preserves a later successful backend result', async () => {
    const f = fixture()
    const pending = f.execute()
    const rejected = expect(pending).rejects.toThrow()
    f.controller.abort()
    expect(f.events.map(event => event.kind)).toEqual(['requested', 'cancel-requested'])
    f.backend(1, 'settled', { ok: true, exitCode: 0 })
    f.response.resolve({ ok: true, exitCode: 0 })
    await rejected
    await f.client.dispose()
    expect(f.notifications.map(event => event.method)).toEqual(['host.sandbox.cancel'])
    expect(f.events.at(-1)).toMatchObject({ kind: 'returned', result: { ok: true, exitCode: 0 } })
    expect(f.events.some(event => event.kind === 'transport-failed')).toBe(false)
  })

  it('reports transport uncertainty without fabricating backend settlement', async () => {
    const f = fixture()
    const pending = f.execute()
    f.response.reject(new Error('private transport detail'))
    await expect(pending).rejects.toThrow()
    await f.client.dispose()
    expect(f.events.map(event => event.kind)).toEqual(['requested', 'transport-failed', 'cancel-requested'])
    expect(JSON.stringify(f.events)).not.toContain('private transport detail')
  })
})
