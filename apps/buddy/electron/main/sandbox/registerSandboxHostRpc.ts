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

export function registerSandboxHostRpc(peer: RuntimeRpcPeerContract, options: SandboxHostOptions): () => void {
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
        child.stdout?.resume()
        child.stderr?.resume()
        childPeer = new BuddyServicePeer({ process: child })
        const processPeer = childPeer
        exited = new Promise(resolve => child!.once('exit', () => {
          processPeer.close(new Error('Sandbox supervisor exited'))
          resolve()
        }))
        child.once('error', () => processPeer.close(new Error('Sandbox supervisor failed')))
        processPeer.onNotification((method, params) => {
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
        child?.kill()
        await exited
        childPeer?.close(new Error('Sandbox command finished'))
        active.delete(input.requestId)
        if (directory)
          await rm(directory, { recursive: true, force: true })
      }
    }),
  ]
  return () => {
    disposed = true
    disposers.forEach(dispose => dispose())
    for (const controller of active.values())
      controller.abort()
  }
}
