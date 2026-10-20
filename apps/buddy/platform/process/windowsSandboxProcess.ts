import type { Buffer } from 'node:buffer'
import type { SandboxProcessState } from '../../shared/permissions/sandboxLifecycle'
import type { OwnedProcessSupervision } from './supervisedShellProcess'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { ShellSandboxError } from '../../shared/permissions/shellSandbox'
import { createWindowsHostEnvironment } from '../windows/powerShell'
import { windowsSupervisedProcessIdentitySchema } from './ownedProcessRecovery'

export interface WindowsSandboxRequest {
  command: string
  cwd: string
  shell: string
  privateRoot: string
  grants: readonly { path: string, access: 'read' | 'write' | 'denyRead' | 'denyWrite', device: string, inode: string, inherit?: boolean, exceptions?: string[] }[]
  denyReadScope?: string
  proxyPort: number
  environment: Record<string, string>
}

type WindowsSandboxPreparationRequest = Pick<WindowsSandboxRequest, 'grants' | 'denyReadScope'> & { synchronizeDenials?: boolean, background?: boolean }

const diagnosticSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), protocol: z.literal(1) }).strict(),
  z.object({ type: z.literal('error'), code: z.string(), nativeCode: z.number().nullable() }).strict(),
  z.object({ type: z.literal('diagnostic'), phase: z.string(), nativeCode: z.number().nullable() }).strict(),
  z.object({ type: z.literal('cleanupError'), code: z.string() }).strict(),
  z.object({ type: z.literal('processesReleased'), protocol: z.literal(1) }).strict(),
  z.object({ type: z.literal('supervisor'), protocol: z.literal(1), identity: windowsSupervisedProcessIdentitySchema }).strict(),
])

export async function runWindowsSandboxProcess(executable: string, request: WindowsSandboxRequest, options: {
  signal: AbortSignal
  onData: (data: Buffer) => void
  onStarted: () => void
  onProcess?: (process: SandboxProcessState) => void
} & Partial<OwnedProcessSupervision>): Promise<number | null> {
  return runProcess(executable, 'run', request, options)
}

export async function prepareWindowsSandboxFilesystem(executable: string, grants: WindowsSandboxRequest['grants'], signal: AbortSignal, options: Omit<WindowsSandboxPreparationRequest, 'grants'> = {}): Promise<void> {
  const code = await runProcess(executable, 'prepare', { grants, ...options }, { signal, onData: () => {}, onStarted: () => {} })
  if (code !== 0)
    throw new ShellSandboxError('SANDBOX_UNAVAILABLE')
}

async function runProcess(executable: string, mode: 'run' | 'prepare', request: WindowsSandboxRequest | WindowsSandboxPreparationRequest, options: {
  signal: AbortSignal
  onData: (data: Buffer) => void
  onStarted: () => void
  onProcess?: (process: SandboxProcessState) => void
} & Partial<OwnedProcessSupervision>): Promise<number | null> {
  options.signal.throwIfAborted()
  const executionId = options.executionId ?? randomUUID()
  const dispatchId = options.dispatchId ?? randomUUID()
  const dispatchProcessId = JSON.stringify({ kind: 'native-shell-dispatch', platform: 'win32', version: 3, executionId, dispatchId })
  const settle = async (processId: string, settlement: 'pending' | 'released' | 'unknown', launchState: 'prepared' | 'authorized' | 'settled') => {
    await options.onSettlement?.({ processId, settlement, launchState, executionId, dispatchId })
  }
  if (mode === 'run')
    await settle(dispatchProcessId, 'pending', 'prepared')
  options.signal.throwIfAborted()
  return new Promise<number | null>((resolve, reject) => {
    let ready = false
    let closed = false
    let cancelled = false
    let authorized = false
    let protocol = Promise.resolve()
    let failed = false
    let processesReleased = false
    let processId: string | undefined
    let exited = false
    let launchError: Error | undefined
    let forceKill: ReturnType<typeof setTimeout> | undefined
    const child = spawn(executable, [mode], { cwd: 'privateRoot' in request ? request.privateRoot : undefined, env: createWindowsHostEnvironment(executable, process.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    child.once('spawn', () => options.onProcess?.({ phase: 'spawned', pid: child.pid }))
    const closeUnknownOutput = () => {
      if (exited && child.stderr.readableEnded && !processesReleased)
        child.stdout.destroy()
    }
    child.stderr.once('end', closeUnknownOutput)
    child.once('exit', (exitCode) => {
      exited = true
      options.onProcess?.({ phase: 'exited', pid: child.pid, exitCode })
      closeUnknownOutput()
    })
    const cancel = () => {
      cancelled = true
      options.onProcess?.({ phase: 'cleanup_requested', pid: child.pid })
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
        if (diagnostic.type === 'supervisor') {
          if (processId || diagnostic.identity.pid !== child.pid)
            throw new Error('Invalid sandbox supervisor identity')
          processId = JSON.stringify({ kind: 'sandbox-job', platform: 'win32', ...diagnostic.identity, ...mode === 'prepare' ? { nonce: randomUUID() } : {} })
          options.onProcess?.({ phase: 'spawned', pid: child.pid, processId })
          if (mode === 'run') {
            if (!('executionId' in diagnostic.identity) || diagnostic.identity.executionId !== executionId || diagnostic.identity.dispatchId !== dispatchId)
              throw new Error('Invalid sandbox launch identity')
            if (closed || cancelled || options.signal.aborted)
              return cancel()
            await settle(processId, 'pending', 'authorized')
            if (closed || cancelled || options.signal.aborted)
              return cancel()
            authorized = true
            child.stdin.write(`${JSON.stringify({ executionId, dispatchId })}\n`)
          }
        }
        if (diagnostic.type === 'ready' && !ready) {
          ready = true
          if (!options.signal.aborted)
            options.onStarted()
        }
        if (diagnostic.type === 'cleanupError')
          options.onProcess?.({ phase: 'cleanup_failed', pid: child.pid })
        if (diagnostic.type === 'error' || diagnostic.type === 'cleanupError')
          failed = true
        if (diagnostic.type === 'processesReleased')
          processesReleased = true
      }).catch(() => {
        failed = true
        cancel()
      })
    })
    child.stdout.on('data', options.onData)
    child.stdin.on('error', () => {})
    child.once('error', (error) => {
      launchError = error
    })
    child.once('close', (code) => {
      closed = true
      void (async () => {
        await protocol
        options.onProcess?.({ phase: 'closed', pid: child.pid, exitCode: code })
        options.onProcess?.({ phase: processesReleased ? 'resources_released' : 'cleanup_failed', pid: child.pid, processId })
        options.signal.removeEventListener('abort', cancel)
        clearTimeout(forceKill)
        lines.close()
        if (mode === 'run') {
          const state = processesReleased || !authorized ? 'released' : 'unknown'
          if (processId)
            await settle(processId, state, 'settled')
          await settle(dispatchProcessId, state, 'settled')
        }
        if (launchError)
          throw launchError
        if (!ready || failed)
          throw new ShellSandboxError(ready ? 'SANDBOX_FAILED' : 'SANDBOX_UNAVAILABLE')
        return code
      })().then(resolve, reject)
    })
    options.signal.addEventListener('abort', cancel, { once: true })
    child.stdin.write(`${JSON.stringify(mode === 'run' ? { ...request, launch: { executionId, dispatchId, receiptDirectory: options.receiptDirectory } } : request)}\n`)
    if (options.signal.aborted)
      cancel()
  })
}
