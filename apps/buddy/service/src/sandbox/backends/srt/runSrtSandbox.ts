import type { ChildProcess } from 'node:child_process'
import type { OwnedProcessSettlement } from '../../../../../platform/process/supervisedShellProcess'
import type { SrtSandboxInput } from '../../../../../shared/permissions/shellSandbox'
import type { SandboxExecutionOptions } from '../../sandboxExecutionLifecycle'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import process from 'node:process'
import { SandboxManager } from '@anthropic-ai/sandbox-runtime'
import { containsCanonicalPath } from '../../../../../platform/filesystem/filePaths'
import { SANDBOX_LOOPBACK_NO_PROXY } from '../../../../../platform/process/sandboxEnvironment'
import { runSupervisedShellProcess } from '../../../../../platform/process/supervisedShellProcess'
import { createSandboxPolicy } from './createPolicy'

export async function runSrtSandbox(input: SrtSandboxInput, options: SandboxExecutionOptions): Promise<number | null> {
  let child: ChildProcess | undefined
  let supervised = false
  let settlement: OwnedProcessSettlement | undefined
  const kill = () => killProcessGroup(child?.pid)
  options.signal.addEventListener('abort', kill, { once: true })
  const release = async () => {
    const pid = settlement ? JSON.parse(settlement.processId).pid as number | undefined : child?.pid
    options.onProcess?.({ phase: 'cleanup_requested', pid, processId: settlement?.processId })
    try {
      kill()
      await SandboxManager.reset()
      options.onProcess?.({ phase: supervised && settlement?.settlement === 'released' ? 'resources_released' : 'cleanup_failed', pid, processId: settlement?.processId })
    }
    catch (error) {
      options.onProcess?.({ phase: 'cleanup_failed', pid: child?.pid })
      throw error
    }
  }
  try {
    const { config, path } = await createSandboxPolicy(input, options.signal)
    const noProxy = process.platform === 'linux' ? SANDBOX_LOOPBACK_NO_PROXY : ''
    await SandboxManager.initialize(config, ({ host, port }) => options.approveNetwork({ host, port: port ?? 443 }), false)
    const launch = await SandboxManager.wrapWithSandboxArgv(
      `export TMPDIR=${quote(process.env.TMPDIR!)} NO_PROXY=${quote(noProxy)} no_proxy=${quote(noProxy)}; exec /bin/bash --noprofile --norc -c ${quote(input.command)}`,
      '/bin/bash',
      undefined,
      options.signal,
      input.cwd,
      { commandId: input.requestId, commandText: input.command },
    )
    options.signal.throwIfAborted()
    if (process.platform === 'linux') {
      supervised = true
      let started = false
      const result = await runSupervisedShellProcess({
        shell: launch.argv[0]!,
        args: launch.argv.slice(1, -1),
        command: launch.argv.at(-1)!,
        cwd: input.cwd,
        environment: {
          ...launch.env,
          PATH: path,
          LEXORA_BUDDY_SANDBOX_BWRAP: config.bwrapPath,
          LEXORA_BUDDY_SANDBOX_TMP: [...input.roots, ...input.additionalDirectories.map(grant => grant.path), ...input.resourceReadRoots].some(root => containsCanonicalPath(root, '/tmp')) ? '/tmp' : join(input.privateRoot, 'tmp'),
        },
      }, {
        signal: options.signal,
        onData: options.onData,
        onProcess: options.onProcess,
        onSettlement(next) {
          settlement = next
          const pid = JSON.parse(next.processId).pid as number | undefined
          if (!started && next.settlement === 'pending') {
            options.onProcess?.({ phase: 'spawned', pid, processId: next.processId })
            started = true
            options.onStarted()
          }
        },
      })
      return result.exitCode
    }
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
