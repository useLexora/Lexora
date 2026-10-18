import type { Buffer } from 'node:buffer'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { supervisedProcessIdentitySchema } from './ownedProcessRecovery'

export interface OwnedProcessSettlement {
  processId: string
  settlement: 'pending' | 'released' | 'unknown'
}

const diagnosticSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), protocol: z.literal(1), identity: supervisedProcessIdentitySchema }).strict(),
  z.object({ type: z.literal('released'), protocol: z.literal(1) }).strict(),
  z.object({ type: z.literal('failed'), code: z.literal('SHELL_SUPERVISION_FAILED'), nativeCode: z.number().nullable() }).strict(),
])

export async function runSupervisedShellProcess(input: {
  shell: string
  args: readonly string[]
  command: string
  commandTransport?: 'argv' | 'stdin'
  cwd: string
  environment: NodeJS.ProcessEnv
}, options: {
  signal?: AbortSignal
  timeout?: number
  onData: (data: Buffer) => void
  onSettlement: (settlement: OwnedProcessSettlement) => void
  onProcess?: (state: { phase: 'exited' | 'closed', pid?: number, exitCode: number | null }) => void
  executable?: string
}): Promise<{ exitCode: number | null }> {
  options.signal?.throwIfAborted()
  const executable = options.executable ?? process.env.LEXORA_BUDDY_PROCESS_CONTROL
  if (!executable)
    throw new Error('SHELL_SUPERVISION_UNAVAILABLE')
  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout * 1000 > 2_147_483_647))
    throw new Error('Invalid shell timeout')
  return new Promise((resolve, reject) => {
    const nonce = randomUUID()
    const dispatchId = JSON.stringify({ kind: 'native-shell-dispatch', platform: process.platform, nonce })
    options.onSettlement({ processId: dispatchId, settlement: 'pending' })
    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(executable, ['--supervise-shell'], { cwd: input.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    }
    catch (error) {
      options.onSettlement({ processId: dispatchId, settlement: 'released' })
      throw error
    }
    let commandDispatched = false
    let processId = JSON.stringify({ kind: 'native-shell', platform: process.platform, pid: child.pid, nonce, startTime: null })
    let ready = false
    let released = false
    let failed = false
    let timedOut = false
    let launchError: Error | undefined
    let forceKill: ReturnType<typeof setTimeout> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let exited = false
    const closeUnknownOutput = () => {
      if (exited && child.stderr.readableEnded && !released)
        child.stdout.destroy()
    }
    const cancel = () => {
      child.stdin.end()
      forceKill ??= setTimeout(() => child.kill(), 10_000)
      forceKill.unref()
    }
    const lines = createInterface({ input: child.stderr })
    lines.on('line', (line) => {
      try {
        const diagnostic = diagnosticSchema.parse(JSON.parse(line))
        if (diagnostic.type === 'ready') {
          if (ready || diagnostic.identity.pid !== child.pid)
            throw new Error('SHELL_SUPERVISION_INVALID_IDENTITY')
          ready = true
          processId = JSON.stringify({ kind: 'native-shell', platform: process.platform, ...diagnostic.identity, nonce })
          options.onSettlement({ processId, settlement: 'pending' })
          if (!options.signal?.aborted && !timedOut) {
            commandDispatched = true
            child.stdin.write(`${JSON.stringify({ ...input, commandTransport: input.commandTransport ?? 'argv', environment: Object.fromEntries(Object.entries(input.environment).filter((entry): entry is [string, string] => entry[1] !== undefined)) })}\n`)
          }
          else { cancel() }
        }
        if (diagnostic.type === 'released')
          released = true
        if (diagnostic.type === 'failed')
          failed = true
      }
      catch (error) {
        launchError = error instanceof Error ? error : new Error('SHELL_SUPERVISION_FAILED')
        failed = true
        cancel()
      }
    })
    child.stdout.on('data', options.onData)
    child.stdin.on('error', () => {})
    child.once('error', (error) => {
      launchError = error
    })
    child.stderr.once('end', closeUnknownOutput)
    child.once('exit', (exitCode) => {
      exited = true
      options.onProcess?.({ phase: 'exited', pid: child.pid, exitCode })
      closeUnknownOutput()
    })
    child.once('close', (exitCode) => {
      options.onProcess?.({ phase: 'closed', pid: child.pid, exitCode })
      options.signal?.removeEventListener('abort', cancel)
      clearTimeout(timeout)
      clearTimeout(forceKill)
      lines.close()
      try {
        const settlement = released || !commandDispatched ? 'released' : 'unknown'
        if (ready)
          options.onSettlement({ processId, settlement })
        options.onSettlement({ processId: dispatchId, settlement })
        if (options.signal?.aborted)
          reject(options.signal.reason ?? new Error('aborted'))
        else if (timedOut)
          reject(new Error(`timeout:${options.timeout}`))
        else if (launchError)
          reject(launchError)
        else if (!ready || failed || !released)
          reject(new Error('SHELL_SUPERVISION_FAILED'))
        else resolve({ exitCode })
      }
      catch (error) { reject(error) }
    })
    options.signal?.addEventListener('abort', cancel, { once: true })
    if (options.timeout !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true
        cancel()
      }, options.timeout * 1000)
      timeout.unref()
    }
    if (options.signal?.aborted)
      cancel()
  })
}
