import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import { rm } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { dirname } from 'node:path'
import process from 'node:process'
import { utilityProcess } from 'electron'
import { z } from 'zod'
import { createProxyEnvironment } from '../../../platform/process/proxyEnvironment'
import { createSandboxDirectory } from '../../../platform/process/sandboxDirectory'
import { createSandboxEnvironment } from '../../../platform/process/sandboxEnvironment'
import { resolveWindowsSandbox } from '../../../platform/process/windowsSandbox'
import { resolveSensitivePathRoots } from '../../../service/src/permissions/sensitivePaths'
import { runSandboxCommand } from '../../../service/src/sandbox/runSandboxCommand'
import sandboxProcessPath from '../../../service/src/sandbox/sandboxProcess?modulePath'
import { Emitter } from '../../../shared/events/Emitter'
import { sandboxLifecycleNotificationSchema } from '../../../shared/permissions/sandboxLifecycle'
import { SANDBOX_RPC_TIMEOUT_MS, sandboxCancelSchema, sandboxCommandSchema, sandboxNetworkRequestSchema, sandboxOutputSchema, sandboxPreparationSchema, sandboxProcessInputSchema, sandboxSettlementAckSchema, sandboxSettlementSchema } from '../../../shared/permissions/shellSandbox'
import { isLinux, isWindows, OPERATING_SYSTEM, SHELL_SANDBOX_BACKEND } from '../../../shared/platform/identifiers'
import { BuddyServicePeer } from '../runtime/BuddyServicePeer'
import { WindowsSandboxPreparation } from './WindowsSandboxPreparation'

export interface SandboxHostOptions {
  buddyHome: string
  receiptDirectory?: string
  protectedRoots?: string[]
  protectionScope?: string
  proxyUrl?: string
  searchDirectory: string
  sandboxDirectory?: string
  windowsSandbox?: string
  windowsShell?: string
  processControl?: string
}

export function registerSandboxHostRpc(peer: RuntimeRpcPeerContract, options: SandboxHostOptions) {
  const changes = new Emitter<Readonly<{ requestId: string, kind: 'spawned' | 'exited' | 'cleanup_requested' | 'resources_released' | 'cleanup_failed', pid?: number, exitCode?: number }>>(() => console.error('SANDBOX_HOST_OBSERVER_FAILED'))
  const publish = (event: Parameters<typeof changes.fire>[0]) => changes.fire(Object.freeze(event))
  const preparation = isWindows(process.platform) ? new WindowsSandboxPreparation({ ...options, protectedRoots: options.protectedRoots ?? [dirname(options.buddyHome)] }) : undefined
  const active = new Map<string, AbortController>()
  const accepted = new Set<string>()
  const finishing = new Map<string, Promise<void>>()
  let disposed = false
  const disposers = [
    peer.onRequest('host.sandbox.prepare', async (params) => {
      const { roots } = sandboxPreparationSchema.parse(params)
      if (disposed)
        throw new Error('SANDBOX_UNAVAILABLE')
      await preparation?.prepare(roots)
      return { ok: true }
    }),
    peer.onNotification((method, params) => {
      if (method !== 'host.sandbox.cancel')
        return
      const parsed = sandboxCancelSchema.safeParse(params)
      if (parsed.success)
        active.get(parsed.data.requestId)?.abort()
    }),
    peer.onRequest('host.sandbox.exec', async (params) => {
      const input = sandboxCommandSchema.parse(params)
      if (!Object.values<string>(OPERATING_SYSTEM).includes(process.platform))
        return { ok: false, code: 'SANDBOX_UNAVAILABLE', notStarted: true }
      if (accepted.has(input.requestId))
        return { ok: false, code: 'SANDBOX_BUSY' }
      if (disposed || active.size >= 8)
        return { ok: false, code: 'SANDBOX_BUSY', notStarted: true }
      accepted.add(input.requestId)
      preparation?.start()
      const controller = new AbortController()
      active.set(input.requestId, controller)
      let finished!: () => void
      finishing.set(input.requestId, new Promise<void>((resolve) => {
        finished = resolve
      }))
      let dispatched = false
      let responded = false
      let directory: string | undefined
      let child: Electron.UtilityProcess | undefined
      let pid: number | undefined
      let childPeer: BuddyServicePeer | undefined
      let exited: Promise<void> | undefined
      let forceKill: ReturnType<typeof setTimeout> | undefined
      const cancel = () => {
        if (!childPeer)
          return
        try {
          childPeer?.notify('sandbox.cancel', {})
        }
        catch {}
        forceKill ??= setTimeout(() => child?.kill(), 15_000)
        forceKill.unref()
      }
      const release = async () => {
        publish({ requestId: input.requestId, kind: 'cleanup_requested', pid })
        try {
          if (responded && childPeer && isLinux(process.platform)) {
            try {
              childPeer.notify('sandbox.close', {})
            }
            catch { child?.kill() }
            const deadline = setTimeout(() => child?.kill(), 1000)
            deadline.unref()
            try {
              await exited
            }
            finally { clearTimeout(deadline) }
          }
          else {
            child?.kill()
            await exited
          }
          childPeer?.close(new Error('Sandbox command finished'))
          if (directory)
            await rm(directory, { recursive: true, force: true })
          publish({ requestId: input.requestId, kind: 'resources_released', pid })
        }
        catch (error) {
          publish({ requestId: input.requestId, kind: 'cleanup_failed', pid })
          throw error
        }
        finally {
          active.delete(input.requestId)
          finishing.delete(input.requestId)
          finished()
          if (disposed && !active.size)
            changes.dispose()
        }
      }
      const settle = async (params: unknown) => {
        const record = sandboxSettlementSchema.parse(params)
        if ((disposed && record.launchState !== 'settled') || record.requestId !== input.requestId || record.executionId !== input.executionId || record.dispatchId !== input.dispatchId
          || (record.launchState === 'authorized' && controller.signal.aborted)) {
          throw new Error('SANDBOX_CANCELLED')
        }
        const result = sandboxSettlementAckSchema.parse(await peer.request('sandbox.settlement', record, 60_000))
        if (record.launchState === 'authorized' && (disposed || controller.signal.aborted))
          throw new Error('SANDBOX_CANCELLED')
        return result
      }
      const network = async (params: unknown) => {
        const target = sandboxNetworkRequestSchema.parse(params)
        if (disposed || controller.signal.aborted || target.requestId !== input.requestId)
          return { allowed: false }
        return peer.request('sandbox.network', target, 30 * 60 * 1_000)
      }
      controller.signal.addEventListener('abort', cancel, { once: true })
      try {
        const windowsSandbox = isWindows(process.platform) ? await resolveWindowsSandbox(options.windowsSandbox) : undefined
        const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
        if (isWindows(process.platform) && (!windowsSandbox || !options.windowsShell || !systemRoot))
          return { ok: false, code: 'SANDBOX_UNAVAILABLE', notStarted: true }
        if (isLinux(process.platform) && !options.sandboxDirectory)
          return { ok: false, code: 'SANDBOX_UNAVAILABLE', notStarted: true }
        directory = await createSandboxDirectory()
        controller.signal.throwIfAborted()
        const command = {
          ...input,
          home: userInfo().homedir,
          sensitiveRoots: resolveSensitivePathRoots(),
          path: process.env.PATH ?? '',
          privateRoot: directory,
          receiptDirectory: options.receiptDirectory,
          protectedRoots: options.protectedRoots ?? [dirname(options.buddyHome)],
          searchDirectory: options.searchDirectory,
          backend: windowsSandbox
            ? { kind: SHELL_SANDBOX_BACKEND.Windows, executable: windowsSandbox, shell: options.windowsShell, systemRoot, protectionScope: options.protectionScope ?? options.buddyHome }
            : isLinux(process.platform)
              ? { kind: SHELL_SANDBOX_BACKEND.Linux, sandboxDirectory: options.sandboxDirectory }
              : { kind: SHELL_SANDBOX_BACKEND.MacOS },
        }
        if (windowsSandbox) {
          dispatched = true
          return await runSandboxCommand(sandboxProcessInputSchema.parse(command), {
            signal: controller.signal,
            environment: {
              ...createSandboxEnvironment(process.env, directory),
              ...(options.proxyUrl ? createProxyEnvironment(options.proxyUrl) : {}),
            },
            async onSettlement(record) {
              await settle({ ...record, requestId: input.requestId })
            },
            onLifecycle(event) {
              if (!disposed)
                peer.notify('host.sandbox.lifecycle', { ...event, requestId: input.requestId })
            },
            onData(data) {
              if (disposed || controller.signal.aborted)
                return
              for (let offset = 0; offset < data.length; offset += 64 * 1024)
                peer.notify('host.sandbox.output', { requestId: input.requestId, data: data.subarray(offset, offset + 64 * 1024).toString('base64') })
            },
            async approveNetwork(target) {
              return z.object({ allowed: z.boolean() }).strict().parse(await network({ ...target, requestId: input.requestId })).allowed
            },
          })
        }
        child = utilityProcess.fork(sandboxProcessPath, [], {
          cwd: directory,
          env: {
            ...createSandboxEnvironment(process.env, directory),
            ...(options.processControl ? { LEXORA_BUDDY_PROCESS_CONTROL: options.processControl } : {}),
            ...(options.proxyUrl ? createProxyEnvironment(options.proxyUrl) : {}),
          },
          serviceName: 'Buddy Shell Sandbox',
          stdio: 'pipe',
        })
        child.once('spawn', () => {
          pid = child?.pid
          publish({ requestId: input.requestId, kind: 'spawned', pid })
        })
        child.stdout?.resume()
        child.stderr?.resume()
        childPeer = new BuddyServicePeer({ process: child })
        const processPeer = childPeer
        exited = new Promise(resolve => child!.once('exit', (exitCode) => {
          publish({ requestId: input.requestId, kind: 'exited', pid, exitCode })
          processPeer.close(new Error('Sandbox supervisor exited'))
          resolve()
        }))
        child.once('error', () => processPeer.close(new Error('Sandbox supervisor failed')))
        processPeer.onNotification((method, params) => {
          if (method === 'sandbox.lifecycle' && !disposed) {
            const event = sandboxLifecycleNotificationSchema.safeParse(params)
            if (event.success && event.data.requestId === input.requestId)
              peer.notify('host.sandbox.lifecycle', event.data)
            return
          }
          if (method !== 'sandbox.output' || disposed || controller.signal.aborted)
            return
          const output = sandboxOutputSchema.parse(params)
          if (output.requestId === input.requestId)
            peer.notify('host.sandbox.output', output)
        })
        processPeer.onRequest('sandbox.settlement', settle)
        processPeer.onRequest('sandbox.network', network)
        dispatched = true
        const result = await processPeer.request('sandbox.exec', command, SANDBOX_RPC_TIMEOUT_MS)
        responded = true
        return result
      }
      catch {
        return { ok: false, code: controller.signal.aborted ? 'SANDBOX_CANCELLED' : 'SANDBOX_UNAVAILABLE', ...(!dispatched ? { notStarted: true } : {}) }
      }
      finally {
        controller.signal.removeEventListener('abort', cancel)
        if (forceKill)
          clearTimeout(forceKill)
        await release()
      }
    }),
  ]
  const dispose = async () => {
    disposed = true
    disposers.forEach(dispose => dispose())
    for (const controller of active.values())
      controller.abort()
    if (!active.size)
      changes.dispose()
    await Promise.all(finishing.values())
    await preparation?.dispose()
  }
  return { dispose, prepare: () => preparation?.start(), onDidChange: changes.event }
}
