import type { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { supervisedProcessIdentitySchema } from './ownedProcessRecovery'

export interface OwnedProcessSettlement {
  processId: string
  settlement: 'pending' | 'released' | 'unknown'
  executionId?: string
  dispatchId?: string
  launchState?: 'prepared' | 'authorized' | 'settled'
}

export interface OwnedProcessSupervision {
  executionId?: string
  dispatchId?: string
  receiptDirectory?: string
  onSettlement: (settlement: OwnedProcessSettlement) => void | Promise<void>
}

const diagnosticSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), protocol: z.literal(2), identity: supervisedProcessIdentitySchema }).strict(),
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
}, options: OwnedProcessSupervision & {
  signal?: AbortSignal
  timeout?: number
  onData: (data: Buffer) => void
  onProcess?: (state: { phase: 'exited' | 'closed', pid?: number, exitCode: number | null }) => void
  executable?: string
}): Promise<{ exitCode: number | null }> {
  options.signal?.throwIfAborted()
  const executable = options.executable ?? process.env.LEXORA_BUDDY_PROCESS_CONTROL
  if (!executable)
    throw new Error('SHELL_SUPERVISION_UNAVAILABLE')
  if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout * 1000 > 2_147_483_647))
    throw new Error('Invalid shell timeout')
  const executionId = z.uuid().parse(options.executionId ?? randomUUID())
  const dispatchId = z.uuid().parse(options.dispatchId ?? randomUUID())
  const dispatchProcessId = JSON.stringify({ kind: 'native-shell-dispatch', platform: process.platform, version: 3, executionId, dispatchId })
  const settle = (processId: string, settlement: OwnedProcessSettlement['settlement'], launchState: OwnedProcessSettlement['launchState']) =>
    options.onSettlement({ processId, settlement, executionId, dispatchId, launchState })
  await settle(dispatchProcessId, 'pending', 'prepared')
  options.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--supervise-shell', JSON.stringify({ executionId, dispatchId, receiptDirectory: options.receiptDirectory })], { cwd: input.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let commandDispatched = false
    let processId: string | undefined
    let released = false
    let failed = false
    let timedOut = false
    let closed = false
    let cancelled = false
    let launchError: Error | undefined
    let forceKill: ReturnType<typeof setTimeout> | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let exited = false
    let protocol = Promise.resolve()
    const closeUnknownOutput = () => {
      if (exited && child.stderr.readableEnded && !released)
        child.stdout.destroy()
    }
    const cancel = () => {
      cancelled = true
      child.stdin.end()
      if (!closed) {
        forceKill ??= setTimeout(() => child.kill(), 10_000)
        forceKill.unref()
      }
    }
    const lines = createInterface({ input: child.stderr })
    lines.on('line', (line) => {
      protocol = protocol.then(async () => {
        const diagnostic = diagnosticSchema.parse(JSON.parse(line))
        if (diagnostic.type === 'ready') {
          if (processId || diagnostic.identity.pid !== child.pid
            || !('executionId' in diagnostic.identity) || diagnostic.identity.executionId !== executionId || diagnostic.identity.dispatchId !== dispatchId) {
            throw new Error('SHELL_SUPERVISION_INVALID_IDENTITY')
          }
          processId = JSON.stringify({ kind: 'native-shell', platform: process.platform, ...diagnostic.identity })
          if (closed || cancelled || options.signal?.aborted || timedOut)
            return cancel()
          await settle(processId, 'pending', 'authorized')
          if (closed || cancelled || options.signal?.aborted || timedOut)
            return cancel()
          commandDispatched = true
          child.stdin.write(`${JSON.stringify({ ...input, executionId, dispatchId, commandTransport: input.commandTransport ?? 'argv', environment: Object.fromEntries(Object.entries(input.environment).filter((entry): entry is [string, string] => entry[1] !== undefined)) })}\n`)
        }
        if (diagnostic.type === 'released')
          released = true
        if (diagnostic.type === 'failed')
          failed = true
      }).catch((error) => {
        launchError = error instanceof Error ? error : new Error('SHELL_SUPERVISION_FAILED')
        failed = true
        cancel()
      })
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
      closed = true
      options.signal?.removeEventListener('abort', cancel)
      clearTimeout(timeout)
      clearTimeout(forceKill)
      lines.close()
      void (async () => {
        await protocol
        options.onProcess?.({ phase: 'closed', pid: child.pid, exitCode })
        const settlement = released || !commandDispatched ? 'released' : 'unknown'
        if (processId)
          await settle(processId, settlement, 'settled')
        await settle(dispatchProcessId, settlement, 'settled')
        if (options.signal?.aborted)
          throw options.signal.reason ?? new Error('aborted')
        if (timedOut)
          throw new Error(`timeout:${options.timeout}`)
        if (launchError)
          throw launchError
        if (!processId || failed || !released)
          throw new Error('SHELL_SUPERVISION_FAILED')
        return { exitCode }
      })().then(resolve, reject)
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
