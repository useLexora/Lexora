import type { SandboxHostOptions } from './registerSandboxHostRpc'
import { userInfo } from 'node:os'
import process from 'node:process'
import { filePaths } from '../../../platform/filesystem/filePaths'
import { resolveUserHomePaths } from '../../../platform/filesystem/userHomePaths'
import { resolveWindowsSandbox } from '../../../platform/process/windowsSandbox'
import { prepareWindowsSandboxFilesystem } from '../../../platform/process/windowsSandboxProcess'
import { resolveSensitivePathRoots } from '../../../service/src/permissions/sensitivePaths'
import { createWindowsSandboxPolicy } from '../../../service/src/sandbox/backends/windows/createPolicy'
import { existingSandboxPaths, existingSandboxSensitivePaths, inspectSandboxPath } from '../../../service/src/sandbox/sandboxFilesystemPolicy'
import { SHELL_SANDBOX_BACKEND } from '../../../shared/platform/identifiers'

export class WindowsSandboxPreparation {
  readonly #options: SandboxHostOptions
  readonly #controller = new AbortController()
  readonly #pending = new Map<string, Promise<void>>()
  #background: Promise<void> | undefined
  #queue: Promise<void> = Promise.resolve()

  constructor(options: SandboxHostOptions) {
    this.#options = options
    this.start()
  }

  start(): void {
    if (this.#background || this.#controller.signal.aborted)
      return
    this.#background = this.#initialize().catch(() => {
      this.#background = undefined
      if (!this.#controller.signal.aborted)
        console.error('SANDBOX_BACKGROUND_PREPARATION_FAILED')
    })
  }

  prepare(roots: readonly string[]): Promise<void> {
    this.start()
    if (!roots.length)
      return Promise.resolve()
    const key = JSON.stringify([...new Set(roots.map(filePaths.sensitiveKey))].sort())
    const existing = this.#pending.get(key)
    if (existing)
      return existing
    const work = this.#queue.then(async () => {
      this.#controller.signal.throwIfAborted()
      const executable = await resolveWindowsSandbox(this.#options.windowsSandbox)
      const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
      if (!systemRoot || !this.#options.windowsShell)
        throw new Error('SANDBOX_UNAVAILABLE')
      const policy = await createWindowsSandboxPolicy({
        roots: [...roots],
        workspaceRoots: [...roots],
        resourceReadRoots: [],
        additionalDirectories: [],
        readOnly: false,
        cwd: roots[0]!,
        home: userInfo().homedir,
        sensitiveRoots: resolveSensitivePathRoots(),
        protectedRoots: this.#options.protectedRoots ?? [],
        searchDirectory: this.#options.searchDirectory,
        path: process.env.PATH ?? '',
        backend: { kind: SHELL_SANDBOX_BACKEND.Windows, executable, shell: this.#options.windowsShell, systemRoot, protectionScope: this.#options.protectionScope ?? this.#options.buddyHome },
      }, this.#controller.signal)
      await prepareWindowsSandboxFilesystem(executable, policy.grants, AbortSignal.any([this.#controller.signal, AbortSignal.timeout(60_000)]), {
        denyReadScope: this.#options.protectionScope ?? this.#options.buddyHome,
      })
    }).finally(() => this.#pending.delete(key))
    this.#pending.set(key, work)
    this.#queue = work.catch(() => {})
    return work
  }

  async dispose(): Promise<void> {
    this.#controller.abort()
    await Promise.allSettled([this.#background, this.#queue])
  }

  async #initialize(): Promise<void> {
    const executable = await resolveWindowsSandbox(this.#options.windowsSandbox)
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
    if (!systemRoot || !this.#options.windowsShell)
      throw new Error('SANDBOX_UNAVAILABLE')
    const protectedPaths = [
      ...await existingSandboxSensitivePaths({
        sensitiveRoots: resolveSensitivePathRoots(),
        backend: { kind: SHELL_SANDBOX_BACKEND.Windows, executable, shell: this.#options.windowsShell, systemRoot, protectionScope: this.#options.protectionScope ?? this.#options.buddyHome },
      }),
      ...await existingSandboxPaths(this.#options.protectedRoots ?? []),
    ]
    const grants = await Promise.all(protectedPaths.map(path => inspectSandboxPath(path, 'denyRead')))
    for (const home of await existingSandboxPaths(resolveUserHomePaths()))
      grants.push(await inspectSandboxPath(home, 'read'))
    await prepareWindowsSandboxFilesystem(executable, grants, AbortSignal.any([this.#controller.signal, AbortSignal.timeout(900_000)]), {
      denyReadScope: this.#options.protectionScope ?? this.#options.buddyHome,
      synchronizeDenials: true,
      background: true,
    })
  }
}
