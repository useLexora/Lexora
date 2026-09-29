import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import { rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import process from 'node:process'
import { utilityProcess } from 'electron'
import { createProxyEnvironment } from '../../../platform/process/proxyEnvironment'
import { createSandboxDirectory } from '../../../platform/process/sandboxDirectory'
import { createSandboxEnvironment } from '../../../platform/process/sandboxEnvironment'
import { resolveWindowsSandbox } from '../../../platform/process/windowsSandbox'
import sandboxProcessPath from '../../../service/src/sandbox/sandboxProcess?modulePath'
import { Emitter } from '../../../shared/events/Emitter'
import { sandboxLifecycleNotificationSchema } from '../../../shared/permissions/sandboxLifecycle'
import { SANDBOX_RPC_TIMEOUT_MS, sandboxCancelSchema, sandboxCommandSchema, sandboxNetworkRequestSchema, sandboxOutputSchema } from '../../../shared/permissions/shellSandbox'
import { isLinux, isWindows, OPERATING_SYSTEM, SHELL_SANDBOX_BACKEND } from '../../../shared/platform/identifiers'
import { BuddyServicePeer } from '../runtime/BuddyServicePeer'

export interface SandboxHostOptions {
  buddyHome: string
  proxyUrl?: string
  searchDirectory: string
  sandboxDirectory?: string
  windowsSandbox?: string
  windowsShell?: string
}

export function registerSandboxHostRpc(peer: RuntimeRpcPeerContract, options: SandboxHostOptions) {
  const changes = new Emitter<Readonly<{ requestId: string, kind: 'spawned' | 'exited' | 'cleanup_requested' | 'resources_released' | 'cleanup_failed', pid?: number, exitCode?: number }>>(() => console.error('SANDBOX_HOST_OBSERVER_FAILED'))
  const publish = (event: Parameters<typeof changes.fire>[0]) => changes.fire(Object.freeze(event))
  const active = new Map<string, AbortController>()
  let disposed = false
  const disposers = [
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
        return { ok: false, code: 'SANDBOX_UNAVAILABLE' }
      if (disposed || active.has(input.requestId) || active.size >= 8)
        return { ok: false, code: 'SANDBOX_BUSY' }
      const controller = new AbortController()
      active.set(input.requestId, controller)
      let directory: string | undefined
      let child: Electron.UtilityProcess | undefined
      let pid: number | undefined
      let childPeer: BuddyServicePeer | undefined
      let exited: Promise<void> | undefined
      let forceKill: ReturnType<typeof setTimeout> | undefined
      const cancel = () => {
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
          child?.kill()
          await exited
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
          if (disposed && !active.size)
            changes.dispose()
        }
      }
      controller.signal.addEventListener('abort', cancel, { once: true })
      try {
        const windowsSandbox = isWindows(process.platform) ? await resolveWindowsSandbox(options.windowsSandbox) : undefined
        const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
        if (isWindows(process.platform) && (!windowsSandbox || !options.windowsShell || !systemRoot))
          return { ok: false, code: 'SANDBOX_UNAVAILABLE' }
        if (isLinux(process.platform) && !options.sandboxDirectory)
          return { ok: false, code: 'SANDBOX_UNAVAILABLE' }
        directory = await createSandboxDirectory()
        controller.signal.throwIfAborted()
        child = utilityProcess.fork(sandboxProcessPath, [], {
          cwd: directory,
          env: {
            ...createSandboxEnvironment(process.env, directory),
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
        processPeer.onRequest('sandbox.network', async (params) => {
          const target = sandboxNetworkRequestSchema.parse(params)
          if (disposed || controller.signal.aborted || target.requestId !== input.requestId)
            return { allowed: false }
          return peer.request('sandbox.network', target, 30 * 60 * 1_000)
        })
        return await processPeer.request('sandbox.exec', {
          ...input,
          home: homedir(),
          path: process.env.PATH ?? '',
          privateRoot: directory,
          protectedRoots: [options.buddyHome],
          searchDirectory: options.searchDirectory,
          backend: windowsSandbox
            ? { kind: SHELL_SANDBOX_BACKEND.Windows, executable: windowsSandbox, shell: options.windowsShell, systemRoot }
            : isLinux(process.platform)
              ? { kind: SHELL_SANDBOX_BACKEND.Linux, sandboxDirectory: options.sandboxDirectory }
              : { kind: SHELL_SANDBOX_BACKEND.MacOS },
        }, SANDBOX_RPC_TIMEOUT_MS)
      }
      catch {
        return { ok: false, code: controller.signal.aborted ? 'SANDBOX_CANCELLED' : 'SANDBOX_UNAVAILABLE' }
      }
      finally {
        controller.signal.removeEventListener('abort', cancel)
        if (forceKill)
          clearTimeout(forceKill)
        await release()
      }
    }),
  ]
  const dispose = () => {
    disposed = true
    disposers.forEach(dispose => dispose())
    for (const controller of active.values())
      controller.abort()
    if (!active.size)
      changes.dispose()
  }
  return { dispose, onDidChange: changes.event }
}
