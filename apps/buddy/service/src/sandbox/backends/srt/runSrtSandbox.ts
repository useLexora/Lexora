import type { ChildProcess } from 'node:child_process'
import type { SrtSandboxInput } from '../../../../../shared/permissions/shellSandbox'
import type { SandboxExecutionOptions } from '../../sandboxExecutionLifecycle'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { createSandboxPolicy } from './createPolicy'

export async function runSrtSandbox(input: SrtSandboxInput, options: SandboxExecutionOptions): Promise<number | null> {
  let child: ChildProcess | undefined
  const kill = () => killProcessGroup(child?.pid)
  options.signal.addEventListener('abort', kill, { once: true })
  const release = async () => {
    options.onProcess?.({ phase: 'cleanup_requested', pid: child?.pid })
    try {
      kill()
      await SandboxManager.reset()
      options.onProcess?.({ phase: 'resources_released', pid: child?.pid })
    }
    catch (error) {
      options.onProcess?.({ phase: 'cleanup_failed', pid: child?.pid })
      throw error
    }
  }
  try {
    const { config, path } = await createSandboxPolicy(input, options.signal)
    await SandboxManager.initialize(config, ({ host, port }) => options.approveNetwork({ host, port: port ?? 443 }), false)
    const launch = await SandboxManager.wrapWithSandboxArgv(
      `export TMPDIR=${quote(process.env.TMPDIR!)} NO_PROXY='' no_proxy=''; exec /bin/bash --noprofile --norc -c ${quote(input.command)}`,
      '/bin/bash',
      undefined,
      options.signal,
      input.cwd,
      { commandId: input.requestId, commandText: input.command },
    )
    options.signal.throwIfAborted()
    return await new Promise<number | null>((resolve, reject) => {
      child = spawn(launch.argv[0]!, launch.argv.slice(1), {
        cwd: input.cwd,
        detached: true,
        env: { ...launch.env, PATH: path },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      child.stdout!.on('data', options.onData)
      child.stderr!.on('data', options.onData)
      child.once('error', reject)
      child.once('exit', exitCode => options.onProcess?.({ phase: 'exited', pid: child?.pid, exitCode }))
      child.once('close', (exitCode) => {
        options.onProcess?.({ phase: 'closed', pid: child?.pid, exitCode })
        resolve(exitCode)
      })
      child.once('spawn', () => {
        options.onProcess?.({ phase: 'spawned', pid: child?.pid })
        options.onStarted()
      })
      if (options.signal.aborted)
        kill()
    })
  }
  finally {
    options.signal.removeEventListener('abort', kill)
    await release()
  }
}

function quote(value: string): string {
  return `'${value.replaceAll('\'', '\'\\\'\'')}'`
}

function killProcessGroup(pid: number | undefined): void {
  if (!pid)
    return
  try {
    process.kill(-pid, 'SIGKILL')
  }
  catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ESRCH')
      throw error
  }
}
