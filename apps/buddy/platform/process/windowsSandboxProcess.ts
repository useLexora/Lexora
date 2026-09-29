import type { Buffer } from 'node:buffer'
import type { SandboxProcessState } from '../../shared/permissions/sandboxLifecycle'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { z } from 'zod'
import { ShellSandboxError } from '../../shared/permissions/shellSandbox'
import { createWindowsHostEnvironment } from '../windows/powerShell'

export interface WindowsSandboxRequest {
  command: string
  cwd: string
  shell: string
  privateRoot: string
  grants: readonly { path: string, access: 'read' | 'write' | 'denyRead' | 'denyWrite', device: string, inode: string, exceptions?: string[] }[]
  proxyPort: number
  environment: Record<string, string>
}

const diagnosticSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), protocol: z.literal(1) }).strict(),
  z.object({ type: z.literal('error'), code: z.string(), nativeCode: z.number().nullable() }).strict(),
  z.object({ type: z.literal('diagnostic'), phase: z.string(), nativeCode: z.number().nullable() }).strict(),
  z.object({ type: z.literal('cleanupError'), code: z.string() }).strict(),
])

export async function runWindowsSandboxProcess(executable: string, request: WindowsSandboxRequest, options: {
  signal: AbortSignal
  onData: (data: Buffer) => void
  onStarted: () => void
  onProcess?: (process: SandboxProcessState) => void
}): Promise<number | null> {
  options.signal.throwIfAborted()
  return new Promise<number | null>((resolve, reject) => {
    let ready = false
    let failed = false
    let launchError: Error | undefined
    let forceKill: ReturnType<typeof setTimeout> | undefined
    const child = spawn(executable, ['run'], { cwd: request.privateRoot, env: createWindowsHostEnvironment(executable, process.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    child.once('spawn', () => options.onProcess?.({ phase: 'spawned', pid: child.pid }))
    child.once('exit', exitCode => options.onProcess?.({ phase: 'exited', pid: child.pid, exitCode }))
    const cancel = () => {
      options.onProcess?.({ phase: 'cleanup_requested', pid: child.pid })
      child.stdin.end()
      forceKill ??= setTimeout(() => child.kill(), 10_000)
      forceKill.unref()
    }
    const lines = createInterface({ input: child.stderr })
    lines.on('line', (line) => {
      try {
        const diagnostic = diagnosticSchema.parse(JSON.parse(line))
        if (diagnostic.type === 'ready' && !ready) {
          ready = true
          if (!options.signal.aborted)
            options.onStarted()
        }
        if (diagnostic.type === 'cleanupError')
          options.onProcess?.({ phase: 'cleanup_failed', pid: child.pid })
        if (diagnostic.type === 'error' || diagnostic.type === 'cleanupError')
          failed = true
      }
      catch {
        failed = true
        cancel()
      }
    })
    child.stdout.on('data', options.onData)
    child.stdin.on('error', () => {})
    child.once('error', (error) => {
      launchError = error
    })
    child.once('close', (code) => {
      options.onProcess?.({ phase: 'closed', pid: child.pid, exitCode: code })
      options.signal.removeEventListener('abort', cancel)
      clearTimeout(forceKill)
      lines.close()
      if (launchError)
        reject(launchError)
      else if (!ready || failed)
        reject(new ShellSandboxError(ready ? 'SANDBOX_FAILED' : 'SANDBOX_UNAVAILABLE'))
      else resolve(code)
    })
    options.signal.addEventListener('abort', cancel, { once: true })
    child.stdin.write(`${JSON.stringify(request)}\n`)
    if (options.signal.aborted)
      cancel()
  })
}
