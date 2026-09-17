import type { SandboxNetworkTarget, SandboxProcessInput, SandboxResult } from '../../../shared/permissions/shellSandbox'
import type { SandboxExecutionOptions } from './sandboxExecutionLifecycle'
import { sandboxNetworkTargetSchema, ShellSandboxError } from '../../../shared/permissions/shellSandbox'
import { SHELL_SANDBOX_BACKEND } from '../../../shared/platform/identifiers'
import { runSrtSandbox } from './backends/srt/runSrtSandbox'
import { runWindowsSandbox } from './backends/windows/runWindowsSandbox'
import { SandboxExecutionLifecycle } from './sandboxExecutionLifecycle'

export async function runSandboxCommand(input: SandboxProcessInput, options: Omit<SandboxExecutionOptions, 'onStarted'>): Promise<SandboxResult> {
  const lifecycle = new SandboxExecutionLifecycle(options.signal, input.timeout)
  const decisions = new Map<string, Promise<boolean>>()
  const requestNetwork = async (target: SandboxNetworkTarget) => {
    const parsed = sandboxNetworkTargetSchema.safeParse(target)
    if (!parsed.success || lifecycle.signal.aborted)
      return false
    const key = `${parsed.data.host.toLowerCase()}:${parsed.data.port}`
    let decision = decisions.get(key)
    if (!decision) {
      decision = lifecycle.approve(() => options.approveNetwork(parsed.data)).catch(() => false)
      decisions.set(key, decision)
    }
    return decision
  }
  try {
    lifecycle.signal.throwIfAborted()
    const execution: SandboxExecutionOptions = {
      ...options,
      signal: lifecycle.signal,
      approveNetwork: requestNetwork,
      onStarted: () => {
        if (!lifecycle.signal.aborted)
          lifecycle.start()
      },
    }
    const exitCode = input.backend.kind === SHELL_SANDBOX_BACKEND.Windows
      ? await runWindowsSandbox({ ...input, backend: input.backend }, execution)
      : await runSrtSandbox({ ...input, backend: input.backend }, execution)
    if (lifecycle.signal.aborted)
      return { ok: false, code: lifecycle.timedOut ? 'SANDBOX_TIMEOUT' : 'SANDBOX_CANCELLED' }
    return { ok: true, exitCode }
  }
  catch (error) {
    return {
      ok: false,
      code: lifecycle.signal.aborted
        ? lifecycle.timedOut ? 'SANDBOX_TIMEOUT' : 'SANDBOX_CANCELLED'
        : error instanceof ShellSandboxError ? error.code : lifecycle.started ? 'SANDBOX_FAILED' : 'SANDBOX_UNAVAILABLE',
    }
  }
  finally {
    lifecycle.finish()
  }
}
