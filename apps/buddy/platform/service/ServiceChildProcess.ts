import type { ChildProcess } from 'node:child_process'
import type { Readable, Writable } from 'node:stream'
import type { z } from 'zod'
import type { serviceProcessIdentitySchema } from '../../shared/service/localServiceProtocol'
import { spawn } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { readServiceProcessIdentity } from './serviceProcessIdentity'

type Identity = z.infer<typeof serviceProcessIdentitySchema>
export interface ServiceProcessReceipt {
  identity: Identity
  processGroup: number | null
}
export class ServiceChildProcess {
  readonly child: ChildProcess
  readonly exited: Promise<{ code: number | null, signal: NodeJS.Signals | null }>
  readonly #helper?: string
  #receipt: ServiceProcessReceipt | undefined
  #exit: { code: number | null, signal: NodeJS.Signals | null } | undefined
  #stopping: Promise<void> | undefined
  readonly #runtimeGuard?: string
  #guardClean: Promise<void> | undefined

  constructor(options: { executable: string, args: string[], env: NodeJS.ProcessEnv, processControl?: string, runtimeGuard?: string, output?: (stream: 'stdout' | 'stderr', value: string) => void }) {
    this.#helper = options.processControl
    this.#runtimeGuard = options.runtimeGuard
    this.child = spawn(options.executable, options.args, { env: options.env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true })
    this.exited = new Promise((resolve, reject) => {
      this.child.once('error', reject)
      this.child.once('exit', (code, signal) => {
        this.#exit = { code, signal }

        resolve(this.#exit)
      })
    })
    void this.exited.catch(() => {})
    this.child.stdout?.on('data', value => options.output?.('stdout', String(value)))
    this.child.stderr?.on('data', value => options.output?.('stderr', String(value)))
  }

  async ready(bootstrap: unknown): Promise<ServiceProcessReceipt> {
    if (!this.child.pid) {
      await new Promise<void>((resolve, reject) => {
        this.child.once('spawn', resolve)

        this.child.once('error', reject)
      })
    }
    const identity = await readServiceProcessIdentity(this.child.pid!, this.#helper)
    this.#receipt = { identity, processGroup: process.platform === 'win32' ? null : identity.pid }
    if (process.platform === 'win32')
      await this.#guard(identity.pid)
    const channel = this.child.stdio[3] as Readable & Writable
    channel.on('error', () => {})
    channel.end(JSON.stringify(bootstrap))
    return this.#receipt
  }

  stopAndVerify(): Promise<void> {
    return this.#stopping ??= this.#stopAndVerify()
  }

  async #stopAndVerify(): Promise<void> {
    const receipt = this.#receipt
    if (!receipt)
      throw new Error('SERVICE_CHILD_IDENTITY_UNAVAILABLE')
    if (receipt.processGroup !== null) {
      if (!this.#exit) {
        const current = await readServiceProcessIdentity(receipt.identity.pid, this.#helper)
        if (current.startIdentity !== receipt.identity.startIdentity || current.executable !== receipt.identity.executable)
          throw new Error('SERVICE_CHILD_IDENTITY_CHANGED')
      }
      for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
        if (!(await this.#groupAlive(receipt.processGroup)))
          return
        try {
          process.kill(-receipt.processGroup, signal)
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH')
            throw error
        }
        const deadline = Date.now() + 3000
        while (Date.now() < deadline) {
          if (!(await this.#groupAlive(receipt.processGroup)))
            return
          await delay(25)
        }
      }
      throw new Error('SERVICE_CHILD_CLEANUP_UNCONFIRMED')
    }
    if (!this.#exit) {
      const current = await readServiceProcessIdentity(receipt.identity.pid, this.#helper)
      if (current.startIdentity !== receipt.identity.startIdentity || current.executable !== receipt.identity.executable)
        throw new Error('SERVICE_CHILD_IDENTITY_CHANGED')
      this.child.kill()
    }
    await Promise.race([this.exited, delay(5000, undefined, { ref: false }).then(() => {
      throw new Error('SERVICE_CHILD_CLEANUP_UNCONFIRMED')
    })])
    if (!this.#guardClean)
      throw new Error('SERVICE_CHILD_CLEANUP_UNCONFIRMED')
    await this.#guardClean
  }

  async #guard(pid: number): Promise<void> {
    if (!this.#runtimeGuard)
      throw new Error('SERVICE_RUNTIME_GUARD_MISSING')
    const guard = spawn(this.#runtimeGuard, [], { env: { SystemRoot: process.env.SystemRoot }, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    let accept!: () => void
    let reject!: (reason: Error) => void
    const ready = new Promise<void>((resolve, fail) => {
      accept = resolve

      reject = fail
    })
    let output = ''
    const timeout = setTimeout(() => reject(new Error('SERVICE_RUNTIME_GUARD_TIMEOUT')), 10000)
    this.#guardClean = new Promise<void>((resolve, fail) => {
      guard.once('error', (error) => {
        reject(error)

        fail(error)
      })
      guard.stdout.on('data', (value) => {
        output += String(value)
        if (output === 'ready\n' || output === 'ready\nclean\n') {
          clearTimeout(timeout)
          accept()
        }
        else if (!'ready\nclean\n'.startsWith(output)) {
          const error = new Error('SERVICE_RUNTIME_GUARD_INVALID')
          reject(error)
          fail(error)
        }
      })
      guard.once('exit', (code) => {
        clearTimeout(timeout)
        if (code === 0 && output === 'ready\nclean\n') {
          resolve()
        }
        else {
          const error = new Error('SERVICE_CHILD_CLEANUP_UNCONFIRMED')
          reject(error)
          fail(error)
        }
      })
    })
    void this.#guardClean.catch(() => {})
    guard.stdin.on('error', error => reject(error))
    guard.stdin.end(JSON.stringify({ pid, observeCleanup: true }))
    await ready
  }

  async #groupAlive(group: number): Promise<boolean> {
    if (process.platform === 'linux') {
      for (const entry of await readdir('/proc')) {
        if (!/^\d+$/.test(entry))
          continue
        const stat = await readFile(`/proc/${entry}/stat`, 'utf8').catch(error => ['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '') ? null : Promise.reject(error))
        if (!stat)
          continue
        const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
        if (Number(fields[2]) === group && !['Z', 'X'].includes(fields[0]!))
          return true
      }
      return false
    }
    try {
      process.kill(-group, 0)

      return true
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH')
        return false
      throw error
    }
  }
}
